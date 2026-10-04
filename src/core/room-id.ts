function halfWidthDigits(input: string): string {
  return input.replace(/[０-９]/gu, (digit) =>
    String.fromCharCode(digit.charCodeAt(0) - 0xfee0),
  );
}

export function normalizeRoomId(input: unknown): string {
  if (typeof input !== "string" || !/^[0-9０-９]{5}$/u.test(input)) {
    throw new Error("ルームIDは5桁の数字にしてください。");
  }
  return halfWidthDigits(input);
}

export function postReferences(body: string): number[] {
  return [...body.matchAll(/(?:>>|＞＞)\s*([0-9０-９]+)/gu)].map((match) =>
    Number(halfWidthDigits(match[1])),
  );
}

export function splitRoomIds(
  body: string,
): { text: string; roomId?: string }[] {
  const parts: { text: string; roomId?: string }[] = [];
  const tokens =
    /(?:>>|＞＞)\s*[0-9０-９]+|(?<![0-9０-９])([0-9０-９]{5})(?![0-9０-９])/gu;
  let offset = 0;
  for (const match of body.matchAll(tokens)) {
    if (!match[1]) continue;
    parts.push({ text: body.slice(offset, match.index) });
    parts.push({ text: match[1], roomId: normalizeRoomId(match[1]) });
    offset = match.index + match[1].length;
  }
  parts.push({ text: body.slice(offset) });
  return parts;
}

export function extractRoomIds(body: string): string[] {
  return [
    ...new Set(
      splitRoomIds(body).flatMap((part) => (part.roomId ? [part.roomId] : [])),
    ),
  ];
}
