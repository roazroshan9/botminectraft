import net from "node:net";
import { logger } from "../lib/logger.js";
import { SUPPORTED_VERSIONS } from "../config/defaults.js";

export async function detectServerVersion(host: string, port: number): Promise<string> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      socket.destroy();
      resolve("1.20.1");
    }, 5000);

    const socket = net.createConnection({ host, port }, () => {
      const handshake = buildHandshake(host, port, -1);
      const statusRequest = Buffer.from([0x01, 0x00]);
      socket.write(handshake);
      socket.write(statusRequest);
    });

    let buffer = Buffer.alloc(0);

    socket.on("data", (data) => {
      buffer = Buffer.concat([buffer, data]);
      try {
        let offset = 0;
        const packetLen = readVarInt(buffer, offset);
        offset += packetLen.bytes;
        if (buffer.length < offset + packetLen.value) return;

        const packetId = readVarInt(buffer, offset);
        offset += packetId.bytes;
        if (packetId.value !== 0x00) return;

        const jsonLen = readVarInt(buffer, offset);
        offset += jsonLen.bytes;
        const json = buffer.subarray(offset, offset + jsonLen.value).toString("utf8");
        const status = JSON.parse(json);
        const rawVersion: string = status?.version?.protocol?.toString() || "";

        clearTimeout(timeout);
        socket.destroy();

        const version = protocolToVersion(rawVersion) || "1.20.1";
        logger.info({ host, port, version }, "Server version detected");
        resolve(version);
      } catch {
        // keep waiting for more data
      }
    });

    socket.on("error", () => {
      clearTimeout(timeout);
      resolve("1.20.1");
    });
  });
}

function buildHandshake(host: string, port: number, nextState: number): Buffer {
  const hostBuf = Buffer.from(host, "utf8");
  const data = [
    writeVarInt(0x00),
    writeVarInt(754),
    writeVarInt(hostBuf.length),
    hostBuf,
    Buffer.from([port >> 8, port & 0xff]),
    writeVarInt(nextState),
  ];
  const payload = Buffer.concat(data);
  return Buffer.concat([writeVarInt(payload.length), payload]);
}

function readVarInt(buf: Buffer, offset: number): { value: number; bytes: number } {
  let value = 0;
  let bytes = 0;
  let byte: number;
  do {
    byte = buf[offset + bytes];
    if (byte === undefined) return { value: 0, bytes: 0 };
    value |= (byte & 0x7f) << (7 * bytes);
    bytes++;
  } while (byte & 0x80);
  return { value, bytes };
}

function writeVarInt(value: number): Buffer {
  const buf: number[] = [];
  do {
    let byte = value & 0x7f;
    value >>>= 7;
    if (value !== 0) byte |= 0x80;
    buf.push(byte);
  } while (value !== 0);
  return Buffer.from(buf);
}

const PROTOCOL_MAP: Record<number, string> = {
  735: "1.16", 736: "1.16.1", 751: "1.16.2", 753: "1.16.3", 754: "1.16.5",
  755: "1.17", 756: "1.17.1",
  757: "1.18", 758: "1.18.2",
  759: "1.19", 760: "1.19.2", 761: "1.19.3", 762: "1.19.4",
  763: "1.20.1", 764: "1.20.2", 765: "1.20.4", 766: "1.20.6",
  767: "1.21", 768: "1.21.1", 769: "1.21.3", 770: "1.21.4",
};

function protocolToVersion(protocol: string): string | undefined {
  const num = parseInt(protocol, 10);
  if (isNaN(num)) return undefined;
  if (PROTOCOL_MAP[num]) return PROTOCOL_MAP[num];
  const keys = Object.keys(PROTOCOL_MAP).map(Number).sort((a, b) => a - b);
  for (let i = keys.length - 1; i >= 0; i--) {
    if (keys[i]! <= num) return PROTOCOL_MAP[keys[i]!];
  }
  return undefined;
}

export function findBestSupportedVersion(detectedVersion: string): string {
  if (SUPPORTED_VERSIONS.includes(detectedVersion)) return detectedVersion;
  const [major, minor] = detectedVersion.split(".").map(Number);
  const best = SUPPORTED_VERSIONS.filter(v => {
    const [ma, mi] = v.split(".").map(Number);
    return ma === major && mi === minor;
  }).pop();
  return best || "1.20.1";
}
