import React from 'react';
import { createRoot } from 'react-dom/client';
import { CommunicationCard } from '../../src/components/table/CommunicationCard';
import '../../src/components/table/table.css';
createRoot(document.getElementById('root')!).render(<main style={{ '--seat-card': '100px', display: 'flex', gap: '30px' } as React.CSSProperties}>
  {(['highest','only','lowest'] as const).map(marker => <CommunicationCard key={marker} communication={{cardId:'blue-5', marker, played:false}} />)}
  <CommunicationCard communication={{cardId:'blue-5',marker:'highest',played:true}} />
</main>);
