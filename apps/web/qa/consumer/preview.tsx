import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ConsumerShell, MarketDiscovery } from './apps/web/src/consumer-ui';
import { ConsumerChart } from './apps/web/src/charts/ConsumerChart';
import { SocialLeaderboard, SocialProfile } from './apps/web/src/social/Social';
import { demoConsumerReadApi } from './apps/web/src/demo/consumerDemo';
import type { ConsumerAction, ConsumerLeaderboard, ConsumerMarket, ConsumerProfile, MarketHistory } from './contracts/consumer';
import './apps/web/src/consumer-ui/consumer.css';

function Preview() {
  const [markets, setMarkets] = useState<ConsumerMarket[]>([]);
  const [history, setHistory] = useState<MarketHistory | null>(null);
  const [board, setBoard] = useState<ConsumerLeaderboard | null>(null);
  const [profile, setProfile] = useState<ConsumerProfile | null>(null);
  const [route, setRoute] = useState<'discover'|'leaderboard'|'activity'|'funds'>('discover');
  const [marketId, setMarketId] = useState<string | null>(null);
  const [selected, setSelected] = useState<ConsumerAction | null>(null);
  useEffect(() => {
    void demoConsumerReadApi.listMarkets().then(setMarkets);
    void demoConsumerReadApi.getLeaderboard('ALL').then(setBoard);
  }, []);
  const openMarket = (id: string) => {
    setMarketId(id); setSelected(null); setRoute('discover');
    void demoConsumerReadApi.getHistory(id, 'ALL').then(setHistory);
  };
  const openProfile = (id: string) => {
    setRoute('activity');
    void demoConsumerReadApi.getProfile(id).then(setProfile);
  };
  const openAction = (action: ConsumerAction) => {
    setSelected(action);
    openMarket(action.marketId);
  };
  return <ConsumerShell mode="DEMO" route={route} onNavigate={next => { setRoute(next); setMarketId(null); setSelected(null); }}
    walletSlot={<span>QA preview · no wallet</span>}>
    <p style={{ fontSize: 12, paddingTop: 8 }}>Isolated QA preview · fictional Demo data · no transaction controls</p>
    {route === 'discover' && !marketId && <MarketDiscovery markets={markets} mode="DEMO" onSelectMarket={openMarket} />}
    {route === 'discover' && marketId && history && <div>
      <button type="button" style={{ minHeight: 44 }} onClick={() => setMarketId(null)}>← Markets</button>
      <ConsumerChart history={history} onSelectAction={action => { setSelected(action); openProfile(action.actorId); }}
        onPeriodChange={period => { void demoConsumerReadApi.getHistory(marketId, period).then(setHistory); }} />
      {selected && <p>Selected action: {selected.id}</p>}
    </div>}
    {route === 'leaderboard' && board && <SocialLeaderboard board={board} onOpenProfile={openProfile} />}
    {route === 'activity' && profile && <SocialProfile profile={profile} onOpenMarket={openMarket}
      marketLabel={id => markets.find(market => market.id === id)?.title ?? id} onOpenAction={openAction} />}
    {route === 'activity' && !profile && <p>Choose a demo actor from the leaderboard.</p>}
    {route === 'funds' && <p>Demo mode has no wallet, test assets, or transaction controls.</p>}
  </ConsumerShell>;
}

createRoot(document.getElementById('root')!).render(<Preview />);
