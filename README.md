# sokoban-push-optimal

[![make.fun bounty](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/cig13zs/sokoban-push-optimal/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/cig13zs/sokoban-push-optimal/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)

A push-optimal Sokoban solver, entered in make.fun's
[Build the best Sokoban solver](https://make.fun/bounty/sokoban-solver-01-run-20261121) bounty.

## What it does

The grader hands the program five levels under `/input/<id>/level.txt` and expects
`/output/<id>/solution.txt`, the player's moves in `LURD`. An instance scores 1,000 points when the
replay takes exactly the level's push-optimal count `P*`, and `500 x P* / pushes` when it takes more,
so the whole game is to land on `P*` on every level.

These levels are drawn by a generator that builds them **room by room**: a hallway one square wide
with up to four rooms off it, each behind a single door. A box pushed out of a door into the hallway
can never be pushed back, so no box ever leaves its room, and the level's push-optimum is exactly
the sum of its rooms' push-optima. This solver uses that:

1. **Split** the level into rooms. A square is *dead* when no push from it can bring a box to any
   goal; the hallway is the player's row, and once its dead squares are cut away every remaining
   part holding a box is one room.
2. **Solve each room push-optimally** on a board of its own (the room, its door, the hallway square
   outside it), never the whole level, so the search never meets the product of the rooms'
   positions. Breadth-first over pushes with the player's reachable region folded into the state, so
   the first solved state found is optimal, and two unavoidable deadlocks pruned: dead squares and
   frozen 2x2 blocks holding a box off a goal.
3. **Lay the walk in** between rooms afterwards. Walking is free in this score (only a step that
   moves a box counts as a push), so the player simply walks from where the last room left it to the
   next room's door.

Work is budgeted in **states, never clock time**, and ties break by square order, so two runs of the
program write byte-identical answers. If a level ever fails to split into rooms, the solver falls
back to one push-optimal search over the whole level, and answers an empty (still valid) solution
rather than nothing, so an instance is never left unanswered.

## Run it

```sh
MAKEFUN_INPUT_DIR=./input MAKEFUN_OUTPUT_DIR=./out node main.ts
```

Node 22.18 or later; no dependencies, standard library only. `main.ts` at the repository root is the
entrypoint the grader runs as `node /bot/main.ts`.

## Measured

On the kit's practice set: **1,000,000 / 1,000,000**, `answered 5`, `passed 1`, every instance on
its optimum (13, 16, 29, 47 and 60 pushes against `P*` 13, 16, 29, 47 and 60). On 300 further
instances drawn from the kit's own generator on seeds the solver had never seen: optimal on 300 of
300, the slowest five-instance set in about 0.65 s against the grader's 60 s budget.

## Licence

MIT, see [LICENSE](LICENSE).
