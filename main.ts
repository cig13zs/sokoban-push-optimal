// A push-optimal Sokoban solver for make.fun's sokoban-solver-01.
//
// The levels this contest draws are built room by room: a hallway one square wide with up to four
// rooms off it, each room a small level of its own behind a single door. A box pushed out of a door
// into the hallway can never come back, so a box never leaves its room and the level's push-optimum
// is the sum of its rooms' push-optima. The search here therefore runs room by room, each room on a
// board of its own (its floor, its door, the hallway square outside it) so that the product of the
// rooms' positions never reaches the search. Walking is free in the score (only a step that moves a
// box costs a push), so the player's walk between rooms is laid in afterwards, square by square.
//
// Each room is solved by a breadth-first search over pushes with the player's reachable region as
// part of the state, so the first solved state it meets is push-optimal, and two deadlocks it can
// never escape are pruned: a dead square (no push from it brings a box to any goal) and a frozen
// 2 x 2 block of walls and boxes holding a box off its goal. Work is budgeted in states, never in
// clock time, so every run of the program answers byte for byte the same.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** The four directions, each with its walk letter and its push letter. */
const DIRS = [
  [0, -1, 'u', 'U'],
  [0, 1, 'd', 'D'],
  [-1, 0, 'l', 'L'],
  [1, 0, 'r', 'R'],
] as const;

/** States one room's search may expand; a room is never kept unless a search this size solves it. */
const ROOM_STATES = 400_000;
/** States one whole level's search may expand when the level does not split into rooms. */
const LEVEL_STATES = 600_000;

interface Level {
  w: number;
  h: number;
  wall: Uint8Array;
  goals: number[];
  boxes: number[];
  player: number;
}

/** A level in XSB as squares: walls, goals, boxes and the player. */
function parseLevel(text: string): Level {
  const rows = text.split('\n').filter((row) => row.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((row) => row.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  for (let y = 0; y < h; y++) {
    const row = rows[y]!;
    for (let x = 0; x < row.length; x++) {
      const ch = row[x]!;
      if (ch === '#') continue;
      const i = y * w + x;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  }
  // The outermost frame is wall whatever it shows, so nothing walks off the board.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
    }
  }
  return { w, h, wall, goals: goals.sort((a, b) => a - b), boxes: boxes.sort((a, b) => a - b), player };
}

/** The squares a box alone could be pushed to a goal from: grown back from the goals over open floor. */
function liveSquares(level: Level): Uint8Array {
  const { w, wall, goals } = level;
  const live = new Uint8Array(wall.length);
  const queue: number[] = [];
  for (const g of goals) {
    live[g] = 1;
    queue.push(g);
  }
  for (let head = 0; head < queue.length; head++) {
    const at = queue[head]!;
    for (const [dx, dy] of DIRS) {
      const step = dy * w + dx;
      const from = at - step;
      if (wall[from] || wall[from - step] || live[from]) continue;
      live[from] = 1;
      queue.push(from);
    }
  }
  return live;
}

/** Marks the squares the player reaches from `from` around walls and `blocked`, and answers the lowest of them. */
function region(level: Level, blocked: Uint8Array, from: number, seen: Int32Array, stamp: number, stack: Int32Array): number {
  const { w, wall } = level;
  let low = from;
  let top = 0;
  stack[top++] = from;
  seen[from] = stamp;
  while (top > 0) {
    const at = stack[--top]!;
    if (at < low) low = at;
    for (let k = 0; k < 4; k++) {
      const to = k === 0 ? at - w : k === 1 ? at + w : k === 2 ? at - 1 : at + 1;
      if (wall[to] || blocked[to] || seen[to] === stamp) continue;
      seen[to] = stamp;
      stack[top++] = to;
    }
  }
  return low;
}

/** Whether the box at `at` stands in a 2 x 2 block of walls and boxes that holds a box off a goal. */
function frozen(level: Level, blocked: Uint8Array, goal: Uint8Array, at: number): boolean {
  const { w, wall } = level;
  for (const corner of [at, at - 1, at - w, at - w - 1]) {
    const right = corner + 1;
    const down = corner + w;
    const both = down + 1;
    if (!(wall[corner] || blocked[corner]) || !(wall[right] || blocked[right])) continue;
    if (!(wall[down] || blocked[down]) || !(wall[both] || blocked[both])) continue;
    if ((blocked[corner] && !goal[corner]) || (blocked[right] && !goal[right])) return true;
    if ((blocked[down] && !goal[down]) || (blocked[both] && !goal[both])) return true;
  }
  return false;
}

/** A state's key: the player's region (its lowest square) above the boxes, as digits of base `size`. */
function keyOf(boxes: number[], low: number, size: number): number {
  let key = low;
  for (const b of boxes) key = key * size + b;
  return key;
}

/** The shortest walk from `from` to `to` around walls and boxes, in walk letters. */
function walkTo(level: Level, blocked: Uint8Array, from: number, to: number): string {
  const { w, wall } = level;
  if (from === to) return '';
  const came = new Int32Array(wall.length).fill(-1);
  const how: string[] = new Array(wall.length).fill('');
  const queue: number[] = [from];
  came[from] = from;
  for (let head = 0; head < queue.length; head++) {
    const at = queue[head]!;
    if (at === to) break;
    for (const [dx, dy, walk] of DIRS) {
      const next = at + dy * w + dx;
      if (wall[next] || blocked[next] || came[next] !== -1) continue;
      came[next] = at;
      how[next] = walk;
      queue.push(next);
    }
  }
  if (came[to] === -1) return '';
  let back = '';
  for (let at = to; at !== from; at = came[at]!) back = how[at]! + back;
  return back;
}

/** The square the player stands on after `moves` from `from` on a board `w` wide. */
function endOf(w: number, from: number, moves: string): number {
  let at = from;
  for (const ch of moves) {
    const low = ch.toLowerCase();
    at += low === 'u' ? -w : low === 'd' ? w : low === 'l' ? -1 : 1;
  }
  return at;
}

/**
 * The push-optimal solution of `level`, searching at most `maxStates` states: its pushes and its
 * moves in LURD (a walk letter, then a push letter), or null when the search gives up.
 */
function solvePushOptimal(level: Level, maxStates: number): { pushes: number; moves: string } | null {
  const { w, wall, goals } = level;
  const size = wall.length;
  const goal = new Uint8Array(size);
  for (const g of goals) goal[g] = 1;
  const live = liveSquares(level);
  if (level.boxes.some((b) => !live[b])) return null;
  const blocked = new Uint8Array(size);
  const seen = new Int32Array(size);
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;
  const solved = (boxes: number[]): boolean => boxes.every((b) => goal[b] === 1);
  // The states in the order they were found: boxes, the square the player pushed from, the parent.
  const boxes: number[][] = [level.boxes];
  const froms: number[] = [level.player];
  const parent: number[] = [-1];
  const index = new Map<number, number>();
  for (const b of level.boxes) blocked[b] = 1;
  index.set(keyOf(level.boxes, region(level, blocked, level.player, seen, ++stamp, stack), size), 0);
  for (const b of level.boxes) blocked[b] = 0;
  let done = solved(level.boxes) ? 0 : -1;
  for (let head = 0; done < 0 && head < boxes.length; head++) {
    const at = boxes[head]!;
    for (const b of at) blocked[b] = 1;
    region(level, blocked, froms[head]!, seen, ++stamp, stack);
    const here = stamp;
    for (let bi = 0; bi < at.length && done < 0; bi++) {
      const b = at[bi]!;
      for (const [dx, dy] of DIRS) {
        const step = dy * w + dx;
        const to = b + step;
        if (seen[b - step] !== here || wall[to] || blocked[to] || live[to] === 0) continue;
        blocked[b] = 0;
        blocked[to] = 1;
        const stuck = frozen(level, blocked, goal, to);
        let next: number[] | null = null;
        let key = -1;
        if (!stuck) {
          next = at.slice();
          next[bi] = to;
          next.sort((x, y) => x - y);
          key = keyOf(next, region(level, blocked, b, mark, ++stamp, stack), size);
        }
        blocked[to] = 0;
        blocked[b] = 1;
        if (stuck || next === null || index.has(key)) continue;
        if (boxes.length >= maxStates) return null;
        index.set(key, boxes.length);
        boxes.push(next);
        froms.push(b);
        parent.push(head);
        if (solved(next)) {
          done = boxes.length - 1;
          break;
        }
      }
    }
    for (const b of at) blocked[b] = 0;
  }
  if (done < 0) return null;
  // The chain of states, then the moves that made it: walk to the push's square, then push.
  const chain: number[] = [];
  for (let s = done; s > 0; s = parent[s]!) chain.push(s);
  chain.reverse();
  let moves = '';
  let player = level.player;
  let stand = level.boxes;
  for (const s of chain) {
    const after = boxes[s]!;
    const start = stand.find((b) => !after.includes(b))!;
    const end = after.find((b) => !stand.includes(b))!;
    const step = end - start;
    const dir = DIRS.find(([dx, dy]) => dy * w + dx === step)!;
    for (const b of stand) blocked[b] = 1;
    moves += walkTo(level, blocked, player, start - step);
    for (const b of stand) blocked[b] = 0;
    moves += dir[3];
    player = start;
    stand = after;
  }
  return { pushes: chain.length, moves };
}

/**
 * The level's squares cut into rooms: the hallway is the player's row (a box there reaches no goal,
 * so those squares are dead), and everything the cut leaves behind that holds a box is a room.
 * Null when the level is no set of rooms.
 */
function roomsOf(level: Level): { squares: number[]; boxes: number[]; goals: number[]; door: number }[] | null {
  const { w, wall, goals, boxes, player } = level;
  if (player < 0) return null;
  const live = liveSquares(level);
  const hallRow = Math.floor(player / w);
  const cut = new Uint8Array(wall.length);
  for (let x = 1; x < w - 1; x++) {
    const at = hallRow * w + x;
    if (!wall[at] && !live[at]) cut[at] = 1;
  }
  if (boxes.some((b) => cut[b] === 1)) return null;
  const part = new Int32Array(wall.length).fill(-1);
  const parts: { squares: number[]; boxes: number[]; goals: number[]; door: number }[] = [];
  for (let s = 0; s < wall.length; s++) {
    if (wall[s] || cut[s] || part[s] >= 0) continue;
    const squares = [s];
    part[s] = parts.length;
    for (let head = 0; head < squares.length; head++) {
      for (const [dx, dy] of DIRS) {
        const next = squares[head]! + dy * w + dx;
        if (wall[next] || cut[next] || part[next] >= 0) continue;
        part[next] = parts.length;
        squares.push(next);
      }
    }
    parts.push({ squares, boxes: [], goals: [], door: -1 });
  }
  for (const b of boxes) parts[part[b]!]!.boxes.push(b);
  for (const g of goals) {
    if (part[g]! < 0) return null;
    parts[part[g]!]!.goals.push(g);
  }
  // A room's door is its square that touches the hallway; the search starts from the hallway square
  // outside it, where the player comes in from.
  for (const room of parts) {
    if (room.boxes.length === 0) continue;
    if (room.boxes.length !== room.goals.length) return null;
    for (const at of room.squares) {
      for (const [dx, dy] of DIRS) {
        const next = at + dy * w + dx;
        if (Math.floor(next / w) === hallRow && !wall[next]) room.door = next;
      }
    }
    if (room.door < 0) return null;
  }
  return parts.filter((room) => room.boxes.length > 0);
}

/** One room's board: its squares, its door and the hallway square outside it, the rest wall. */
function roomBoard(level: Level, room: { squares: number[]; door: number }, player: number): Level {
  const wall = new Uint8Array(level.wall.length).fill(1);
  for (const at of room.squares) wall[at] = 0;
  wall[room.door] = 0;
  return {
    w: level.w,
    h: level.h,
    wall,
    goals: room.goals.slice(),
    boxes: room.boxes.slice().sort((a, b) => a - b),
    player,
  };
}

/**
 * `moves` that solve every room of `level`, or the best the search could do within its budget:
 * each room solved push-optimally in turn from its own door, the player walking on from where the
 * last room left it, every box it has put on a goal standing there for good.
 */
function solveByRooms(level: Level, rooms: NonNullable<ReturnType<typeof roomsOf>>): { pushes: number; moves: string } | null {
  let player = level.player;
  let pushes = 0;
  let moves = '';
  const standing = level.boxes.slice();
  for (const room of rooms) {
    const board = roomBoard(level, room, room.door);
    const solved = solvePushOptimal(board, ROOM_STATES);
    if (solved === null) return null;
    const blocked = new Uint8Array(level.wall.length);
    for (const b of standing) blocked[b] = 1;
    const walk = walkTo(level, blocked, player, room.door);
    if (walk === '' && player !== room.door) return null;
    moves += walk + solved.moves;
    pushes += solved.pushes;
    player = endOf(level.w, room.door, solved.moves);
    // Every box of the room now stands on a goal: it stays there while the other rooms are solved.
    for (const b of room.boxes) standing.splice(standing.indexOf(b), 1);
    for (const g of room.goals) standing.push(g);
    standing.sort((a, b) => a - b);
  }
  return { pushes, moves };
}

/** The level's solution: room by room when it splits into rooms, else one search over the level. */
function solve(text: string): string {
  const level = parseLevel(text);
  if (level.player < 0 || level.boxes.length === 0) return '';
  const rooms = roomsOf(level);
  if (rooms !== null) {
    const solved = solveByRooms(level, rooms);
    if (solved !== null) return solved.moves;
  }
  const whole = solvePushOptimal(level, LEVEL_STATES);
  return whole === null ? '' : whole.moves;
}

for (const id of readdirSync(INPUT).sort()) {
  const text = readFileSync(join(INPUT, id, 'level.txt'), 'utf8');
  const moves = solve(text);
  mkdirSync(join(OUTPUT, id), { recursive: true });
  writeFileSync(join(OUTPUT, id, 'solution.txt'), `${moves}\n`);
}
