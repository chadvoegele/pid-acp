import { Console } from "node:console";

export const logger = new Console({
	stdout: process.stderr,
	stderr: process.stderr,
});
