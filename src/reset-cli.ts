/** CLI: `council reset` — wipe process state, reseed the task, judges-first pass.
 * Run from the task's repository. Children need pi: COUNCIL_PI or `pi` on PATH. */
import { resetTask } from "./reset.ts";

if (!process.env.COUNCIL_PI) process.env.COUNCIL_PI = "pi";
const judges = !process.argv.includes("--no-judges");
try {
	const result = await resetTask(process.cwd(), { judges, log: (line) => console.error(line) });
	console.log(JSON.stringify(result, null, 1));
} catch (error) {
	console.error(`council reset: ${(error as Error).message}`);
	process.exit(1);
}
