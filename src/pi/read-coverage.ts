import { truncateHead, type AgentToolResult, type ReadToolDetails, type ReadToolInput } from "@earendil-works/pi-coding-agent";

export function returnedReadRange(buffer: Buffer, params: ReadToolInput, result: AgentToolResult<ReadToolDetails | undefined>): [number, number] {
  const text = buffer.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(buffer)) return [0, 0];
  if ((params.offset !== undefined && !Number.isInteger(params.offset))
    || (params.limit !== undefined && (!Number.isInteger(params.limit) || params.limit < 0))) return [0, 0];
  const lines = text.split("\n");
  const first = params.offset ? Math.max(0, params.offset - 1) : 0;
  const stop = params.limit === undefined ? lines.length : Math.min(first + params.limit, lines.length);
  const selected = lines.slice(first, stop).join("\n");
  const truncation = truncateHead(selected);
  if (first >= lines.length || stop <= first || truncation.firstLineExceedsLimit) return [0, 0];
  const output = result.content.length === 1 && result.content[0].type === "text" ? result.content[0].text : undefined;
  if (output === undefined || result.isError) return [0, 0];
  const payload = truncation.content;
  if (output !== payload && !output.startsWith(payload + "\n\n[")) return [0, 0];
  if (truncation.truncated && (result.details?.truncation?.content !== payload
    || result.details.truncation.outputBytes !== truncation.outputBytes
    || result.details.truncation.outputLines !== truncation.outputLines)) return [0, 0];
  const start = Buffer.byteLength(lines.slice(0, first).join("\n"), "utf8") + (first > 0 ? 1 : 0);
  let end = start + Buffer.byteLength(payload, "utf8");
  if ((truncation.truncated || stop < lines.length) && buffer[end] === 0x0a) end++;
  return [start, end];
}
