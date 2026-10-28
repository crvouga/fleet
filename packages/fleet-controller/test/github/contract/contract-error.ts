/** A request, answer or payload that breaks GitHub's published contract, or is not in it. */
export class ContractError extends Error {
  constructor(
    message: string,
    readonly problems: readonly string[] = []
  ) {
    super(
      problems.length === 0
        ? message
        : `${message}\n  - ${problems.join('\n  - ')}`
    );
    this.name = 'ContractError';
  }
}
