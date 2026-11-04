import React from 'react';
export const wallet={address:'Vote111111111111111111111111111111111111111',cluster:'devnet',signer:{},supportedTransactionVersions:new Set(['legacy'])};
export const connected={account:{address:wallet.address}};
export const useConnectedWallet=()=>faucetControl.connected?{account:{address:wallet.address}}:null;
export const walletClient={};export const walletCluster='devnet';
export const currentWalletContext=()=>faucetControl.connected?wallet:null;
export const WalletConnectPrompt=()=> <span>Fixture wallet connected</span>;
export const apiClock={nowSeconds:()=>Math.floor(Date.now()/1000)};
export const isFixture=false;
export const readySol={balanceLamports:'100000000',minimumBalanceLamports:'1000000',needsSol:false,serverGrantEnabled:true,grantLamports:'20000000',grantRemaining:'10',serverGrantAvailable:false,grantUnavailableReason:'ENOUGH_SOL'};
export const faucetControl:any={connected:true,solPending:null,readiness:async()=>readySol,claim:async()=>({state:'UNKNOWN',signature:null,amountLamports:'20000000'})};
export const visitorSolFlow={readiness:()=>faucetControl.readiness(),pending:()=>faucetControl.solPending,
 claim:()=>{counters.solClaims++;return faucetControl.claim();},recheck:async()=>{counters.solRechecks++;return {state:'UNKNOWN',signature:null,amountLamports:'20000000'};}};
let pending:any=null,finish:any=null,pendingOwner:string|null=null;
export const counters={signs:0,quotes:0,solClaims:0,solRechecks:0};
export const liveFinancialFlow={
  pending:(context:any)=>context?.address===pendingOwner?pending:null,canExecute:()=>true,cancelReview:()=>{},prepareQuote:async()=>null,
  portfolio:()=>faucetControl.portfolio(),
  faucetCapacity:async()=>({remainingClaims:'10',payoutAtoms:'1000000000'}),
  quote:async(intent:any)=>(counters.quotes++,faucetControl.quote?faucetControl.quote(intent):{kind:'quote',quote:{id:'browser-quote',intent,phase:'INDEXED',priceAtoms:'1000000',grossAtoms:'1000000',tradeFeeAtoms:'1000',timePrepaidAtoms:'0',maxPaymentAtoms:'1001000',minReceiveAtoms:'900000',maxPayoutAtoms:null,maturityAt:null,expiresAt:apiClock.nowSeconds()+30,configVersion:'1',stateVersion:'1',snapshot:null,chain:{address:'fixture-registration'}}}),
  signReviewed:()=>{counters.signs++;pendingOwner=wallet.address;pending={requestId:'browser-pending-1',action:'spotBuy',signature:null};return new Promise(resolve=>{finish=resolve;});},
  recheck:async()=>({state:'UNKNOWN',requestId:pending.requestId,signature:null,reason:'Fixture request remains unresolved'}),
};
export function resetPanel(){pending=null;finish=null;pendingOwner=null;Object.keys(counters).forEach(k=>(counters as any)[k]=0);wallet.address='Vote111111111111111111111111111111111111111';wallet.cluster='devnet';faucetControl.portfolio=null;faucetControl.quote=null;faucetControl.connected=true;faucetControl.solPending=null;faucetControl.readiness=async()=>readySol;faucetControl.claim=async()=>({state:'UNKNOWN',signature:null,amountLamports:'20000000'});}
export function finishUnknown(){finish({state:'UNKNOWN',requestId:pending.requestId,signature:null,reason:'Fixture request remains unresolved'});}
