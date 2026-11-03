/** Only gates starting a new wallet request. Existing requests reconcile separately. */
export function marketSigningBlocked(input:{busy:boolean;unavailable:string|null;pending:unknown;canExecute:boolean;remaining:number}):boolean {
  return input.busy || !!input.unavailable || !!input.pending || !input.canExecute || input.remaining<=0;
}
