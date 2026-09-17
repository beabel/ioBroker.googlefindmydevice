'use strict';

// Minimal gRPC client (over Node's built-in http2 module - no grpc library
// dependency) for Google's Spot API (spot-pa.googleapis.com), used only for
// the E2EE owner-key lookup (GetEidInfoForE2eeDevices). The Nova API
// (nova-api.js) used for day-to-day device polling is plain REST and does
// not need this.
//
// Protocol reference: SpotApi/spot_request.py and SpotApi/grpc_parser.py in
// leonboe1/GoogleFindMyTools (GPL-3.0). gRPC wire format (1-byte compression
// flag + 4-byte big-endian length prefix + payload) is the public gRPC
// spec, not anything reverse-engineered.

const http2 = require('node:http2');
const path = require('node:path');
const protobuf = require('protobufjs');

const SPOT_ORIGIN = 'https://spot-pa.googleapis.com';
const SPOT_SERVICE = 'google.internal.spot.v1.SpotService';

let protoRoot = null;

async function loadProto() {
  if (protoRoot) return protoRoot;
  protoRoot = await protobuf.load(path.join(__dirname, 'proto', 'device_update.proto'));
  return protoRoot;
}

function frameGrpcMessage(payload) {
  const header = Buffer.alloc(5);
  header.writeUInt8(0, 0); // uncompressed
  header.writeUInt32BE(payload.length, 1);
  return Buffer.concat([header, payload]);
}

function unframeGrpcMessage(buf) {
  if (buf.length < 5) {
    throw new Error('Invalid gRPC payload (too short)');
  }
  const length = buf.readUInt32BE(1);
  return buf.subarray(5, 5 + length);
}

const HTTP_TIMEOUT_MS = 15000;

function spotRequest(apiMethod, spotToken, payloadBuf) {
  return new Promise((resolve, reject) => {
    const client = http2.connect(SPOT_ORIGIN);
    client.on('error', reject);
    client.setTimeout(HTTP_TIMEOUT_MS, () => {
      client.destroy(new Error('Spot API request timed out'));
    });

    const req = client.request({
      ':method': 'POST',
      ':path': `/${SPOT_SERVICE}/${apiMethod}`,
      'content-type': 'application/grpc',
      te: 'trailers',
      authorization: `Bearer ${spotToken}`,
      'user-agent': 'com.google.android.gms/244433022 grpc-java-cronet/1.69.0-SNAPSHOT',
      'grpc-accept-encoding': 'gzip',
    });

    let httpStatus = null;
    let grpcStatus = null;
    let grpcMessage = null;
    const chunks = [];

    req.on('response', headers => {
      httpStatus = headers[':status'];
      if (headers['grpc-status'] !== undefined) grpcStatus = headers['grpc-status'];
      if (headers['grpc-message'] !== undefined) grpcMessage = headers['grpc-message'];
    });
    req.on('data', chunk => chunks.push(chunk));
    req.on('trailers', trailers => {
      if (trailers['grpc-status'] !== undefined) grpcStatus = trailers['grpc-status'];
      if (trailers['grpc-message'] !== undefined) grpcMessage = trailers['grpc-message'];
    });
    req.on('end', () => {
      client.close();
      if (httpStatus !== 200) {
        reject(new Error(`Spot API HTTP error: ${httpStatus}`));
        return;
      }
      if (grpcStatus !== undefined && grpcStatus !== null && String(grpcStatus) !== '0') {
        reject(new Error(`Spot API gRPC error ${grpcStatus}: ${grpcMessage || '(no message)'}`));
        return;
      }
      try {
        resolve(unframeGrpcMessage(Buffer.concat(chunks)));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);

    req.end(frameGrpcMessage(payloadBuf));
  });
}

/**
 * Fetches the account's current encrypted E2EE owner key (still needs to be
 * decrypted locally with the "shared key" obtained from Google's
 * encryption-unlock page - see lib/owner-key.js).
 *
 * @param {string} spotToken - bearer token from performOAuth(email, aasToken,
 *   androidId, 'oauth2:https://www.googleapis.com/auth/spot', 'com.google.android.gms', ...)
 */
async function getEidInfoForE2eeDevices(spotToken) {
  const root = await loadProto();
  const RequestType = root.lookupType('googlefindmydevice.GetEidInfoForE2eeDevicesRequest');
  const ResponseType = root.lookupType('googlefindmydevice.GetEidInfoForE2eeDevicesResponse');

  const requestMsg = RequestType.create({ ownerKeyVersion: -1, hasOwnerKeyVersion: true });
  const requestBuf = RequestType.encode(requestMsg).finish();

  const responseBuf = await spotRequest('GetEidInfoForE2eeDevices', spotToken, requestBuf);
  const decoded = ResponseType.decode(responseBuf);
  return ResponseType.toObject(decoded, { longs: String, defaults: true });
}

module.exports = { getEidInfoForE2eeDevices };
