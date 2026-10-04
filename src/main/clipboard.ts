import { clipboard } from "electron";
import { normalizeRoomId } from "../core/room-id";

export function copyRoomId(input: unknown): void {
  clipboard.writeText(normalizeRoomId(input));
}
