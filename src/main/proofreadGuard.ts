/** Stream-time protection against pathological repeated proofread output. */
export function detectProofreadLoop(text: string): string | null {
  if (text.length < 240) return null;

  const completeLines = text.split("\n").filter((line) => line.trim().length > 0);
  if (completeLines.length >= 3) {
    const last = completeLines[completeLines.length - 1].trim();
    const previous = completeLines[completeLines.length - 2].trim();
    const beforePrevious = completeLines[completeLines.length - 3].trim();
    if (last.length >= 20 && last === previous && last === beforePrevious) return "repeated-line";
  }

  // Catch a token-level loop even if it never completes a newline-delimited output row.
  const tail = text.slice(-900);
  const width = 56;
  if (tail.length >= width * 3) {
    const probe = tail.slice(-width);
    let count = 0;
    let from = 0;
    while ((from = tail.indexOf(probe, from)) !== -1) {
      count += 1;
      from += probe.length;
    }
    if (count >= 3) return "repeated-span";
  }
  return null;
}
