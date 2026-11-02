export const MAX_PLAYERS = 50;
export const MAX_COUNTER = 1_000_000;
export const MAX_BODY_BYTES = 2_048;
export const MAX_CAS_ATTEMPTS = 8;
export const MAX_STATE_BYTES = 60_000;
export const DEFAULT_ROOM_LABEL = "Unsere Dino-Runde";

export interface Player {
  id: string;
  nickname: string;
  tokenHash: string;
  meals: number;
  mathSolved: number;
}

export interface Room {
  id: string;
  label: string;
  inviteHash: string | null;
  createdAt: string;
  updatedAt: string;
  players: Player[];
}

export interface VersionedRoom {
  room: Room;
  etag: string;
}

export interface RoomStore {
  read(roomId: string): Promise<VersionedRoom | undefined>;
  create(room: Room): Promise<void>;
  replace(room: Room, etag: string): Promise<void>;
  remove(roomId: string, etag: string): Promise<void>;
}

export interface Score {
  meals: number;
  mathSolved: number;
  total: number;
}

export interface LeaderboardEntry extends Score {
  playerId: string;
  nickname: string;
  rank: number;
}

export function scoreOf(player: Pick<Player, "meals" | "mathSolved">): Score {
  return {
    meals: player.meals,
    mathSolved: player.mathSolved,
    total: player.meals + player.mathSolved,
  };
}

export function publicRoom(room: Room): { id: string; label: string } {
  return { id: room.id, label: room.label };
}
