import React from 'react';
export const wallet={address:'Vote111111111111111111111111111111111111111',cluster:'devnet',signer:{},supportedTransactionVersions:new Set(['legacy'])};
export const connected={account:{address:wallet.address}};
export const useConnectedWallet=()=>connected;
export const walletClient={};export const walletCluster='devnet';
export const currentWalletContext=()=>wallet;
export const WalletConnectPrompt=()=> <span>Fixture wallet connected</span>;
export const apiClock={nowSeconds:()=>Math.floor(Date.now()/1000)};
export const isFixture=false,visitorSolFlow=null;
let pending:any=null,finish:any=null;
export const counters={signs:0};
export const liveFinancialFlow={
  pending:()=>pending,canExecute:()=>true,cancelReview:()=>{},prepareQuote:async()=>null,
  quote:async(intent:any)=>({kind:'quote',quote:{id:'browser-quote',intent,phase:'INDEXED',priceAtoms:'1000000',grossAtoms:'1000000',tradeFeeAtoms:'1000',timePrepaidAtoms:'0',maxPaymentAtoms:'1001000',minReceiveAtoms:'900000',maxPayoutAtoms:null,maturityAt:null,expiresAt:apiClock.nowSeconds()+30,configVersion:'1',stateVersion:'1',snapshot:null}}),
  signReviewed:()=>{counters.signs++;pending={requestId:'browser-pending-1',action:'spotBuy',signature:null};return new Promise(resolve=>{finish=resolve;});},
  recheck:async()=>({state:'UNKNOWN',requestId:pending.requestId,signature:null,reason:'Fixture request remains unresolved'}),
};
export function resetPanel(){pending=null;finish=null;counters.signs=0;}
export function finishUnknown(){finish({state:'UNKNOWN',requestId:pending.requestId,signature:null,reason:'Fixture request remains unresolved'});}
