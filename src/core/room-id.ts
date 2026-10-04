export function normalizeRoomId(input: unknown): string {
  if (typeof input !== "string" || !/^[0-9０-９]{5}$/u.test(input)) {
    throw new Error("ルームIDは5桁の数字にしてください。");
  }
  return input.replace(/[０-９]/gu, (digit) =>
    String.fromCharCode(digit.charCodeAt(0) - 0xfee0),
  );
}

export function splitRoomIds(
  body: string,
): { text: string; roomId?: string }[] {
  return body
    .split(/(?<![0-9０-９])([0-9０-９]{5})(?![0-9０-９])/u)
    .map((text, index) =>
      index % 2 === 1 ? { text, roomId: normalizeRoomId(text) } : { text },
    );
}
