export class SessionOpenError extends Error {
	constructor(
		message: string,
		readonly fatal = false,
	) {
		super(message);
	}
}
