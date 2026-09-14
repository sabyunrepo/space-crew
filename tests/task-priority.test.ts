import { describe, expect, it } from 'vitest';
import type { Snapshot } from '../shared/contracts.ts';
import { priorityTaskIds } from '../src/components/table/taskPriority.ts';
import { taskTokenLabel } from '../src/components/table/taskToken.ts';
type Task = Snapshot['tasks'][number];
const task = (id: string, token: Task['token'] = null, status: Task['status'] = 'pending'): Task => ({ id, cardId: 'blue-1', ownerId: 'owner', order: null, token, status });
const view = (tasks: Task[], overrides = {}) => ({ tasks, phase: 'playing' as const, missionId: 22, players: [{ cardCount: 4 }] as Snapshot['players'], ...overrides });
describe('public task priorities', () => {
  it('advances relative priority while keeping unordered goals available', () => {
    const tasks = [task('a', {kind:'relative',value:1}), task('b',{kind:'relative',value:2}), task('free')];
    expect([...priorityTaskIds(view(tasks))]).toEqual(['a','free']);
    tasks[0].status='success';
    expect([...priorityTaskIds(view(tasks))]).toEqual(['b','free']);
    expect(taskTokenLabel(tasks[1])).toBe('>>');
    expect(taskTokenLabel(task('four',{kind:'relative',value:4}))).toBe('>>>>');
  });
  it('reserves the next absolute slot and permits free goals in unnumbered slots', () => {
    const tasks = [task('first',{kind:'absolute',value:1}), task('third',{kind:'absolute',value:3}), task('free')];
    expect([...priorityTaskIds(view(tasks))]).toEqual(['first']);
    tasks[0].status='success';
    expect([...priorityTaskIds(view(tasks))]).toEqual(['free']);
    tasks[2].status='success';
    expect([...priorityTaskIds(view(tasks))]).toEqual(['third']);
  });
  it('supports old order-only snapshots', () => {
    const first={...task('old'),token:undefined,order:1};
    expect([...priorityTaskIds(view([first,task('free')]))]).toEqual(['old']);
  });
  it('keeps omega last and mission 48 on the last trick', () => {
    const tasks=[task('free'),task('omega',{kind:'omega'})];
    expect([...priorityTaskIds(view(tasks))]).toEqual(['free']);
    tasks[0].status='success';
    expect([...priorityTaskIds(view(tasks))]).toEqual(['omega']);
    expect([...priorityTaskIds(view(tasks,{missionId:48}))]).toEqual([]);
    expect([...priorityTaskIds(view(tasks,{missionId:48,players:[{cardCount:0},{cardCount:1}]}))]).toEqual(['omega']);
  });
  it('never highlights completed, unassigned, failed or preparation goals', () => {
    const tasks=[task('done',null,'success'),task('next'),{...task('unassigned'),ownerId:null}];
    expect([...priorityTaskIds(view(tasks))]).toEqual(['next']);
    for(const phase of ['briefing','preparation','task_selection','success','failure']) expect([...priorityTaskIds(view(tasks,{phase}))]).toEqual([]);
    tasks[0].status='failed';expect([...priorityTaskIds(view(tasks))]).toEqual([]);
  });
});
