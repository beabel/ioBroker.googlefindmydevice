'use strict';

// Structure-only view of a protobuf message: which field numbers are present,
// with which wire type and size. Used for the debug log when Google sends a
// device whose identifier lives in a field our schema does not know yet.
// It never outputs string or byte contents, so names and ids cannot leak.

const MAX_DEPTH = 2;
const MAX_FIELDS = 24;

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
 * @returns {string} the structure, or an empty string if the buffer is not a well-formed message
 */
function describeStructure(buf, depth = 0) {
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
                const nested = depth < MAX_DEPTH && f.data.length > 0 ? describeStructure(f.data, depth + 1) : '';
                return nested ? `${f.no}{${nested}}` : `${f.no}:len${f.data.length}`;
            }
            return `${f.no}:fixed${f.data.length * 8}`;
        })
        .join(',');
}

/**
 * Finds the structure of the identifier block (field 1) of every device in a
 * raw DevicesList response (devices are repeated field 2), in list order.
 *
 * @param {Buffer} listBuf the raw ListDevices response
 * @returns {string[]} one structure string per device ('' if it has none)
 */
function describeIdentifierBlocks(listBuf) {
    const top = scanFields(listBuf) || [];
    return top
        .filter(f => f.no === 2 && f.wire === 2)
        .map(device => {
            const inner = scanFields(device.data) || [];
            const identifier = inner.find(f => f.no === 1 && f.wire === 2);
            return identifier ? describeStructure(identifier.data) : '';
        });
}

module.exports = { describeStructure, describeIdentifierBlocks };
