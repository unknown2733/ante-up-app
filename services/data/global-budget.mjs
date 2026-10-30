import {DatabaseSync} from 'node:sqlite';
import {mkdirSync} from 'node:fs';
import {dirname} from 'node:path';

const DAY=/^\d{4}-\d{2}-\d{2}$/;
const MARKET=/^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const positive=value=>Number.isSafeInteger(value)&&value>0;
export const DEFAULT_GLOBAL_X_LIMITS=Object.freeze({
  dailyLimitMicros:10_000_000,totalLimitMicros:150_000_000,
  initialLimitMicros:100_000_000
});

/** Shared, conservative reservations across all paid X collectors. */
export class GlobalXBudget {
  constructor(path,{dailyLimitMicros=DEFAULT_GLOBAL_X_LIMITS.dailyLimitMicros,
    totalLimitMicros=DEFAULT_GLOBAL_X_LIMITS.totalLimitMicros,
    initialLimitMicros=DEFAULT_GLOBAL_X_LIMITS.initialLimitMicros}={}){
    if(!positive(dailyLimitMicros)||!positive(totalLimitMicros)||!positive(initialLimitMicros)||
        initialLimitMicros>totalLimitMicros)throw Error('GLOBAL_X_BUDGET_CONFIG_INVALID');
    mkdirSync(dirname(path),{recursive:true});
    this.limits={dailyLimitMicros,totalLimitMicros,initialLimitMicros};
    this.db=new DatabaseSync(path);
    this.db.exec(`PRAGMA busy_timeout=30000;
      CREATE TABLE IF NOT EXISTS x_spend(
        id TEXT PRIMARY KEY,market_id TEXT NOT NULL,day TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('initial','regular')),
        estimated_cost_micros INTEGER NOT NULL CHECK(estimated_cost_micros>0),
        reserved_at INTEGER NOT NULL
      );`);
  }
  close(){this.db.close();}
  reserve({id,marketId,day,kind,costMicros,at}){
    if(typeof id!=='string'||!id||!MARKET.test(marketId)||!DAY.test(day)||
        !['initial','regular'].includes(kind)||!positive(costMicros)||
        !Number.isSafeInteger(at)||at<0)throw Error('GLOBAL_X_BUDGET_INPUT_INVALID');
    this.db.exec('BEGIN IMMEDIATE');
    try{
      const prior=this.db.prepare('SELECT market_id,day,kind,estimated_cost_micros FROM x_spend WHERE id=?').get(id);
      if(prior){
        if(prior.market_id!==marketId||prior.day!==day||prior.kind!==kind||
            prior.estimated_cost_micros!==costMicros)throw Error('GLOBAL_X_BUDGET_ID_CONFLICT');
        this.db.exec('COMMIT');return 'ALREADY_RESERVED';
      }
      const totals=this.db.prepare(`SELECT
        COALESCE(SUM(estimated_cost_micros),0) total,
        COALESCE(SUM(CASE WHEN day=? THEN estimated_cost_micros ELSE 0 END),0) daily,
        COALESCE(SUM(CASE WHEN kind='initial' THEN estimated_cost_micros ELSE 0 END),0) initial
        FROM x_spend`).get(day);
      if(totals.total+costMicros>this.limits.totalLimitMicros||
          totals.daily+costMicros>this.limits.dailyLimitMicros||
          (kind==='initial'&&totals.initial+costMicros>this.limits.initialLimitMicros))
        throw Error('BUDGET_EXHAUSTED');
      this.db.prepare('INSERT INTO x_spend VALUES(?,?,?,?,?,?)')
        .run(id,marketId,day,kind,costMicros,at);
      this.db.exec('COMMIT');return 'RESERVED';
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  totals(day){
    if(!DAY.test(day))throw Error('GLOBAL_X_BUDGET_INPUT_INVALID');
    const row=this.db.prepare(`SELECT COALESCE(SUM(estimated_cost_micros),0) total,
      COALESCE(SUM(CASE WHEN day=? THEN estimated_cost_micros ELSE 0 END),0) daily,
      COALESCE(SUM(CASE WHEN kind='initial' THEN estimated_cost_micros ELSE 0 END),0) initial
      FROM x_spend`).get(day);
    return {total:row.total,daily:row.daily,initial:row.initial};
  }
}
