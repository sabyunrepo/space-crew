import { createRoot } from 'react-dom/client';
import { useState, type CSSProperties } from 'react';
import { createState, newPlayer, project } from '../../src/game/engine';
import { PlayerSeat } from '../../src/components/table/PlayerSeat';
import { TaskCard } from '../../src/components/table/TaskCard';
import { CommunicationCard } from '../../src/components/table/CommunicationCard';
import { TrickArea } from '../../src/components/table/TrickArea';
import { priorityTaskIds } from '../../src/components/table/taskPriority';
import { CardHoverInfo } from '../../src/components/CardHoverInfo';
import '../../src/styles.css';
import '../../src/components/table/table.css';
import '../../src/theme.css';
const owner='10000000-0000-4000-8000-000000000001';
const state=createState(owner,'콜드',{name:'카드 상태 검수',capacity:3,startMission:22,missionMode:'sequential'},'snow');
state.players.push(newPlayer('10000000-0000-4000-8000-000000000002','코모도',1),newPlayer('10000000-0000-4000-8000-000000000003','타마마',2));
state.phase='playing';state.missionId=22;state.trickNumber=2;state.commanderId=owner;state.turnPlayerId=state.players[2].id;
state.hands[owner]=['blue-5','green-2'];
state.tasks=(['blue-1','green-2','yellow-3','black-4'] as const).map((cardId,i)=>({id:`20000000-0000-4000-8000-00000000000${i}`,cardId,ownerId:state.players[1].id,order:null,token:{kind:'relative' as const,value:i+1},status:i===0?'success' as const:'pending' as const}));
state.trick=[{playerId:owner,cardId:'blue-5'},{playerId:state.players[1].id,cardId:'blue-2'}];
function Fixture(){
 const [completed,setCompleted]=useState(1);
 const [light,setLight]=useState(false);
 const [blocked,setBlocked]=useState(false);
 const [wide,setWide]=useState(false);
 const snapshot=project(state,owner);
 snapshot.tasks.forEach((t,i)=>t.status=i<completed?'success':'pending');
 if(blocked)snapshot.missionProgress!.silentPlayerId=owner;
 snapshot.me.canCommunicate=!blocked;
 const priorities=priorityTaskIds(snapshot);
 return <main style={{padding:20,maxWidth:1100,margin:'auto','--seat-card':'88px','--task-card':'88px'} as CSSProperties}>
  <h1>카드 상태 로컬 검수</h1><p>표시 상태를 재현하는 검수 화면입니다.</p>
  <div style={{display:'flex',gap:12,flexWrap:'wrap',marginBlock:16}}>
   <button onClick={()=>setCompleted(v=>v===4?0:v+1)}>다음 목표 완료</button>
   <button onClick={()=>{setLight(v=>!v);document.documentElement.dataset.theme=light?'dark':'light';}}>테마 전환</button>
   <button onClick={()=>setBlocked(v=>!v)}>대원 교신 제한 전환</button>
   <button onClick={()=>setWide(v=>!v)}>목표 영역 비율 전환</button>
  </div>
  <section aria-label="목표 상태" style={{display:'flex',gap:20,padding:12,flexWrap:'wrap'}}>{snapshot.tasks.map(t=><TaskCard key={t.id} task={t} priority={priorities.has(t.id)}/>)}</section>
  <section aria-label="교신 상태 비교" style={{display:'flex',gap:24,flexWrap:'wrap',marginBlock:28}}>
   <CommunicationCard communication={null}/><CommunicationCard communication={null} blockedReason="교신 금지"/>
   <CommunicationCard communication={{cardId:'blue-5',marker:'lowest',played:true}}/>
   <CommunicationCard communication={{cardId:'blue-5',marker:'hidden',played:false}}/>
  </section>
  <div className="own-seat-dock" style={{width:"min(100%,340px)",height:210}}><PlayerSeat snapshot={snapshot} player={snapshot.players[0]} mineId={owner} position="south" onCommunicate={()=>{}} compactIdentity/></div>
  <div style={{height:wide?280:640,display:'flex',marginTop:20}}><TrickArea snapshot={snapshot} mineId={owner}/></div>
  <CardHoverInfo/>
 </main>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
