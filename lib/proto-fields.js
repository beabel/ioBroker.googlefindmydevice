'use strict';

// Structure-only view of a protobuf message: which field numbers are present,
// with which wire type and size. Used for the debug log when Google sends a
// device whose identifier lives in a field our schema does not know yet.
// It never outputs string or byte contents, so names and ids cannot leak.

const MAX_DEPTH = 2;
const ENTRY_MAX_DEPTH = 5;
const MAX_FIELDS = 24;
const MAX_DESCRIPTION_LENGTH = 600;
const ALTERNATIVE_INFORMATION_PATH = [10, 11];
const UUID_PATTERN = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

/**
 * Reads a base-128 varint.
 *
 * @param {Buffer} buf the buffer
 * @param {number} pos start position
 * @returns {{value: number, pos: number} | null} the value and the next position, or null if malformed
 */
function readVarint(buf, pos) {
    let value = 0;
    let shift = 0;
    while (pos < buf.length && shift < 35) {
        const b = buf[pos++];
        value += (b & 0x7f) * 2 ** shift;
        if ((b & 0x80) === 0) {
            return { value, pos };
        }
        shift += 7;
    }
    return null;
}

/**
 * Splits a message into its top-level fields.
 *
 * @param {Buffer} buf the encoded message
 * @returns {Array<{no: number, wire: number, value?: number, data?: Buffer}> | null} the fields, or null if the buffer is not a well-formed message
 */
function scanFields(buf) {
    const fields = [];
    let pos = 0;
    while (pos < buf.length) {
        const tag = readVarint(buf, pos);
        if (!tag) {
            return null;
        }
        pos = tag.pos;
        const no = Math.floor(tag.value / 8);
        const wire = tag.value % 8;
        if (no < 1) {
            return null;
        }
        if (wire === 0) {
            const v = readVarint(buf, pos);
            if (!v) {
                return null;
            }
            pos = v.pos;
            fields.push({ no, wire, value: v.value });
        } else if (wire === 1 || wire === 5) {
            const size = wire === 1 ? 8 : 4;
            if (pos + size > buf.length) {
                return null;
            }
            pos += size;
            fields.push({ no, wire, data: buf.subarray(pos - size, pos) });
        } else if (wire === 2) {
            const len = readVarint(buf, pos);
            if (!len || len.pos + len.value > buf.length) {
                return null;
            }
            fields.push({ no, wire, data: buf.subarray(len.pos, len.pos + len.value) });
            pos = len.pos + len.value;
        } else {
            return null;
        }
    }
    return fields;
}

/**
 * Describes the structure of an encoded message, e.g. `1{2:len36},2=5,3:len0`.
 * `=n` is a small varint value, `:lenN` a length-delimited field (string, bytes
 * or a nested message that could not be read), `{...}` a nested message.
 *
 * @param {Buffer} buf the encoded message
 * @param {number} [depth] current nesting depth
 * @param {number} [maxDepth] how deep nested messages are followed
 * @returns {string} the structure, or an empty string if the buffer is not a well-formed message
 */
function describeStructure(buf, depth = 0, maxDepth = MAX_DEPTH) {
    const fields = scanFields(buf);
    if (!fields) {
        return '';
    }
    return fields
        .slice(0, MAX_FIELDS)
        .map(f => {
            if (f.wire === 0) {
                return f.value < 1000 ? `${f.no}=${f.value}` : `${f.no}=big`;
            }
            if (f.wire === 2) {
                const nested =
                    depth < maxDepth && f.data.length > 0 ? describeStructure(f.data, depth + 1, maxDepth) : '';
                return nested ? `${f.no}{${nested}}` : `${f.no}:len${f.data.length}`;
            }
            return `${f.no}:fixed${f.data.length * 8}`;
        })
        .join(',');
}

/**
 * Splits a raw DevicesList response into its device entries (repeated field 2).
 *
 * @param {Buffer} listBuf the raw ListDevices response
 * @returns {Buffer[]} one buffer per device, in list order
 */
function deviceEntries(listBuf) {
    return (scanFields(listBuf) || []).filter(f => f.no === 2 && f.wire === 2).map(f => f.data);
}

/**
 * Follows a path of length-delimited fields into a message.
 *
 * @param {Buffer} buf the encoded message
 * @param {number[]} fieldPath field numbers to descend through, outermost first
 * @returns {Buffer | null} the nested message, or null if the path does not exist
 */
function readNested(buf, fieldPath) {
    let current = buf;
    for (const no of fieldPath) {
        const field = (scanFields(current) || []).find(f => f.no === no && f.wire === 2);
        if (!field) {
            return null;
        }
        current = field.data;
    }
    return current;
}

/**
 * Headphones and other Fast Pair devices keep their device information (the
 * registration with the encrypted identity key, the access list) in field 10 ->
 * 11 of the device entry instead of field 4. Fills `information` from there
 * when the schema decode found none.
 *
 * @param {{information?: object | null}} metadata the decoded device entry (changed in place)
 * @param {Buffer} metadataBuf the encoded device entry
 * @param {{decode: (buf: Buffer) => object, toObject: (message: object, options?: object) => object}} informationType the protobuf type DeviceInformation
 * @returns {boolean} true if `information` was taken from the alternative place
 */
function fillAlternativeInformation(metadata, metadataBuf, informationType) {
    if (!metadata || metadata.information) {
        return false;
    }
    const nested = readNested(metadataBuf, ALTERNATIVE_INFORMATION_PATH);
    if (!nested) {
        return false;
    }
    try {
        metadata.information = informationType.toObject(informationType.decode(nested), {
            defaults: true,
            longs: String,
            enums: String,
        });
        return true;
    } catch {
        return false;
    }
}

/**
 * Finds the structure of the identifier block (field 1) of every device in a
 * raw DevicesList response (devices are repeated field 2), in list order.
 *
 * @param {Buffer} listBuf the raw ListDevices response
 * @returns {string[]} one structure string per device ('' if it has none)
 */
function describeIdentifierBlocks(listBuf) {
    return deviceEntries(listBuf).map(entry => {
        const identifier = (scanFields(entry) || []).find(f => f.no === 1 && f.wire === 2);
        return identifier ? describeStructure(identifier.data) : '';
    });
}

/**
 * Structure of every complete device entry (identifier, registration,
 * location data, ...) in list order, followed deeper than the identifier view,
 * and cut off at a fixed length. Contents are never shown.
 *
 * @param {Buffer} listBuf the raw ListDevices response
 * @returns {string[]} one structure string per device
 */
function describeDeviceEntries(listBuf) {
    return deviceEntries(listBuf).map(entry => {
        const text = describeStructure(entry, 0, ENTRY_MAX_DEPTH);
        return text.length > MAX_DESCRIPTION_LENGTH ? `${text.slice(0, MAX_DESCRIPTION_LENGTH)}...` : text;
    });
}

/**
 * Looks for a canonic id (a UUID string) anywhere inside the identifier block
 * (field 1) of every device, including in fields the schema does not know.
 * Headphones and other Fast Pair devices carry theirs in field 5 instead of 3.
 *
 * @param {Buffer} listBuf the raw ListDevices response
 * @returns {Array<string | null>} the first id found per device, null if there is none
 */
function findIdentifierIds(listBuf) {
    /**
     * @param {Buffer} buf a message
     * @param {number} depth current nesting depth
     * @returns {string | null} the first UUID string inside the message
     */
    const search = (buf, depth) => {
        for (const f of scanFields(buf) || []) {
            if (f.wire !== 2) {
                continue;
            }
            const text = f.data.toString('latin1');
            if (UUID_PATTERN.test(text)) {
                return text;
            }
            const inner = depth < ENTRY_MAX_DEPTH ? search(f.data, depth + 1) : null;
            if (inner) {
                return inner;
            }
        }
        return null;
    };
    return deviceEntries(listBuf).map(entry => {
        const identifier = (scanFields(entry) || []).find(f => f.no === 1 && f.wire === 2);
        return identifier ? search(identifier.data, 0) : null;
    });
}

module.exports = {
    describeStructure,
    describeIdentifierBlocks,
    describeDeviceEntries,
    findIdentifierIds,
    deviceEntries,
    readNested,
    fillAlternativeInformation,
};
