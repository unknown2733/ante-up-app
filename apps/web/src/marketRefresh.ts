import type {MarketView} from '../../../contracts/types';

export type MarketReadState={value:MarketView|null;error:string;loading:boolean};
/** Hold price-dependent actions. Fixed claims still require fresh wallet/chain checks. */
export function heldMarket(value:MarketView|null):MarketView|null {
  return value?{...value,price:null,priceReadiness:{state:'UNAVAILABLE',dataThrough:value.priceReadiness?.dataThrough??value.snapshot?.payload.dataThrough??0},
    capabilities:Object.fromEntries(Object.entries(value.capabilities).map(([action,capability])=>[action,action==='claim'?capability:{allowed:false,reason:'DATA_NOT_READY'}]))}:null;
}
export type ScopedMarketRead=MarketReadState & {identity:string;revision:string};
export function mergeMarketRead(previous:ScopedMarketRead,state:MarketReadState,identity:string,revision:string):ScopedMarketRead {
  return {...state,identity,revision,value:state.value??((state.loading||state.error)&&previous.identity===identity?heldMarket(previous.value):null)};
}
export function currentMarketRead(state:ScopedMarketRead,identity:string,revision:string):MarketReadState {
  if(state.identity!==identity)return {value:null,error:'',loading:true};
  return state.revision===revision?state:{value:heldMarket(state.value),error:'',loading:true};
}
export function createMarketRefresh(input:{id:string;load:()=>Promise<{data:MarketView|null}>;
  publish:(state:MarketReadState)=>void;visible:()=>boolean;
  schedule?:(callback:()=>void,ms:number)=>ReturnType<typeof setTimeout>|number;
  cancel?:(timer:ReturnType<typeof setTimeout>|number)=>void}) {
  let active=true,generation=0,inFlight=false,queued=false,timer:ReturnType<typeof setTimeout>|number|undefined;
  let value:MarketView|null=null;
  const cancel=()=>{if(timer!==undefined)(input.cancel??clearTimeout)(timer);timer=undefined;};
  const schedule=(ms:number)=>{cancel();timer=(input.schedule??setTimeout)(()=>{
    if(input.visible())void retry();else schedule(ms);
  },ms);};
  async function retry(){
    if(!active)return;
    if(inFlight){queued=true;++generation;return;}
    inFlight=true;
    cancel();const request=++generation;
    value=heldMarket(value);input.publish({value,error:'',loading:true});
    try{
      const response=await input.load();
      if(!active||request!==generation)return;
      if(response.data && response.data.id!==input.id)throw Error('Market identity could not be verified.');
      value=response.data;input.publish({value,error:'',loading:false});
      schedule(value?.priceReadiness?.state==='SYNCING'?5000:60000);
    }catch{
      if(!active||request!==generation)return;
      input.publish({value:heldMarket(value),error:'Could not reach the market data service. Retrying automatically. You can also retry now.',loading:false});
      schedule(15000);
    }finally{
      inFlight=false;
      if(active&&queued){queued=false;void retry();}
    }
  }
  return {retry,stop(){active=false;++generation;cancel();}};
}

