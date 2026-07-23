type WorkerHandler = {
  fetch: (request: Request, env: unknown, ctx: unknown) => Response | Promise<Response>;
  scheduled?: (controller: unknown, env: unknown, ctx: unknown) => unknown;
};

const CP1252_REVERSE = new Map<number, number>([
  [0x20ac, 0x80], [0x201a, 0x82], [0x0192, 0x83], [0x201e, 0x84],
  [0x2026, 0x85], [0x2020, 0x86], [0x2021, 0x87], [0x02c6, 0x88],
  [0x2030, 0x89], [0x0160, 0x8a], [0x2039, 0x8b], [0x0152, 0x8c],
  [0x017d, 0x8e], [0x2018, 0x91], [0x2019, 0x92], [0x201c, 0x93],
  [0x201d, 0x94], [0x2022, 0x95], [0x2013, 0x96], [0x2014, 0x97],
  [0x02dc, 0x98], [0x2122, 0x99], [0x0161, 0x9a], [0x203a, 0x9b],
  [0x0153, 0x9c], [0x017e, 0x9e], [0x0178, 0x9f],
]);

const MOJIBAKE_MARKER = /(?:Ã|Â|â|ð|à¤|à¥|à¦|à§|à¨|à©|àª|à«|à¬|à­|à®|à¯|à°|à±|à²|à³|à´|àµ)/;
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

function windows1252Byte(character: string): number | null {
  const codePoint = character.codePointAt(0);
  if (codePoint === undefined) return null;
  if (codePoint <= 0xff) return codePoint;
  return CP1252_REVERSE.get(codePoint) ?? null;
}

function utf8SequenceLength(firstByte: number): number {
  if (firstByte >= 0xc2 && firstByte <= 0xdf) return 2;
  if (firstByte >= 0xe0 && firstByte <= 0xef) return 3;
  if (firstByte >= 0xf0 && firstByte <= 0xf4) return 4;
  return 0;
}

function isValidUtf8Sequence(bytes: number[]): boolean {
  if (bytes.length < 2) return false;
  for (let index = 1; index < bytes.length; index += 1) {
    if (bytes[index] < 0x80 || bytes[index] > 0xbf) return false;
  }

  if (bytes[0] === 0xe0 && bytes[1] < 0xa0) return false;
  if (bytes[0] === 0xed && bytes[1] > 0x9f) return false;
  if (bytes[0] === 0xf0 && bytes[1] < 0x90) return false;
  if (bytes[0] === 0xf4 && bytes[1] > 0x8f) return false;
  return true;
}

function decodeMojibakeOnce(value: string): string {
  const characters = Array.from(value);
  const bytes = characters.map(windows1252Byte);
  let output = "";

  for (let index = 0; index < characters.length;) {
    const firstByte = bytes[index];
    if (firstByte === null) {
      output += characters[index];
      index += 1;
      continue;
    }

    const sequenceLength = utf8SequenceLength(firstByte);
    if (sequenceLength > 0 && index + sequenceLength <= characters.length) {
      const sequence = bytes.slice(index, index + sequenceLength);
      if (
        sequence.every((byte): byte is number => byte !== null) &&
        isValidUtf8Sequence(sequence)
      ) {
        try {
          output += utf8Decoder.decode(Uint8Array.from(sequence));
          index += sequenceLength;
          continue;
        } catch {
          // Preserve the original character when decoding is not safe.
        }
      }
    }

    output += characters[index];
    index += 1;
  }

  return output;
}

export function repairMojibake(value: string): string {
  let repaired = value;
  for (let attempt = 0; attempt < 3 && MOJIBAKE_MARKER.test(repaired); attempt += 1) {
    const next = decodeMojibakeOnce(repaired);
    if (next === repaired) break;
    repaired = next;
  }
  return repaired;
}

function repairJsonValue(value: unknown): unknown {
  if (typeof value === "string") return repairMojibake(value);
  if (Array.isArray(value)) return value.map(repairJsonValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, child]) => [
        key,
        repairJsonValue(child),
      ]),
    );
  }
  return value;
}

const nativeFetch = globalThis.fetch.bind(globalThis);
const repairedFetch: typeof fetch = async (input, init) => {
  let nextInit = init;
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;

  if (
    /^https:\/\/graph\.facebook\.com\//i.test(url) &&
    typeof init?.body === "string"
  ) {
    const contentType = new Headers(init.headers).get("content-type") ?? "";
    if (contentType.toLowerCase().includes("application/json")) {
      try {
        const payload = JSON.parse(init.body) as unknown;
        nextInit = {
          ...init,
          body: JSON.stringify(repairJsonValue(payload)),
        };
      } catch {
        // Keep the original request if it is not valid JSON.
      }
    }
  }

  return nativeFetch(input, nextInit);
};

try {
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    writable: true,
    value: repairedFetch,
  });
} catch {
  (globalThis as unknown as { fetch: typeof fetch }).fetch = repairedFetch;
}

let handlerPromise: Promise<WorkerHandler> | null = null;

function loadHandler(): Promise<WorkerHandler> {
  if (!handlerPromise) {
    handlerPromise = import("./index").then((module) => module.default as WorkerHandler);
  }
  return handlerPromise;
}

async function repairWorkerResponse(response: Response): Promise<Response> {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (
    !contentType.includes("text/") &&
    !contentType.includes("application/json") &&
    !contentType.includes("application/javascript")
  ) {
    return response;
  }

  const repairedBody = repairMojibake(await response.text());
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  headers.delete("etag");

  return new Response(repairedBody, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export default {
  async fetch(request: Request, env: unknown, ctx: unknown): Promise<Response> {
    const handler = await loadHandler();
    return repairWorkerResponse(await handler.fetch(request, env, ctx));
  },
  scheduled(controller: unknown, env: unknown, ctx: unknown): void {
    const executionContext = ctx as { waitUntil?: (promise: Promise<unknown>) => void };
    const task = loadHandler().then((handler) => handler.scheduled?.(controller, env, ctx));
    executionContext.waitUntil?.(task);
  },
};
