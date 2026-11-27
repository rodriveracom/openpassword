// A refusal whose message was written for the caller, agents included. The error handler marks only
// these as public; a message from the framework or a library is never marked.
export class Refusal extends Error {
  readonly statusCode: number
  constructor(statusCode: number, message: string) {
    super(message)
    this.statusCode = statusCode
  }
}
