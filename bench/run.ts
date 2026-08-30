import { $ } from "bun";

const here = import.meta.dir;
for (const f of ["seek.bench.ts", "join.bench.ts", "write.bench.ts", "transactor.bench.ts"]) {
  console.log(`\n=== ${f} ===`);
  await $`bun run ${here}/${f}`;
}
