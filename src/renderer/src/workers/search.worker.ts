interface SearchRequest {
  requestId: number;
  content: string | null;
  query: string;
  preferredOffset: number | null;
}

interface SearchResponse {
  requestId: number;
  matches: ArrayBuffer;
  preferredIndex: number;
}

let latestRequestId = 0;
let currentContent = "";
const workerScope = self as unknown as {
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<SearchRequest>) => void,
  ): void;
  postMessage(message: SearchResponse, transfer?: Transferable[]): void;
};

workerScope.addEventListener("message", (event) => {
  const request = event.data;
  latestRequestId = request.requestId;
  if (!request.query) {
    const empty = new Uint32Array(0);
    const response: SearchResponse = {
      requestId: request.requestId,
      matches: empty.buffer,
      preferredIndex: -1,
    };
    workerScope.postMessage(response, [empty.buffer]);
    return;
  }

  if (request.content !== null) currentContent = request.content;
  const content = currentContent;
  const { query, requestId, preferredOffset } = request;
  const maxStart = content.length - query.length;
  let buffer = new Uint32Array(1024);
  let count = 0;
  let preferredIndex = -1;
  let cursor = 0;

  const scanChunk = () => {
    if (requestId !== latestRequestId) return;
    const chunkEnd = Math.min(maxStart + 1, cursor + 32_768);
    while (cursor < chunkEnd) {
      const start = content.indexOf(query, cursor);
      if (start === -1 || start >= chunkEnd) {
        cursor = chunkEnd;
        break;
      }
      if (count === buffer.length) {
        const expanded = new Uint32Array(buffer.length * 2);
        expanded.set(buffer);
        buffer = expanded;
      }
      buffer[count] = start;
      if (
        preferredIndex === -1 &&
        preferredOffset !== null &&
        start >= preferredOffset
      )
        preferredIndex = count;
      count += 1;
      cursor = start + query.length;
    }

    if (cursor < maxStart + 1) {
      setTimeout(scanChunk, 0);
      return;
    }

    const matches = buffer.slice(0, count);
    const response: SearchResponse = {
      requestId,
      matches: matches.buffer,
      preferredIndex,
    };
    workerScope.postMessage(response, [matches.buffer]);
  };

  if (maxStart < 0) {
    const empty = new Uint32Array(0);
    const response: SearchResponse = {
      requestId,
      matches: empty.buffer,
      preferredIndex: -1,
    };
    workerScope.postMessage(response, [empty.buffer]);
    return;
  }
  scanChunk();
});
