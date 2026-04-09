/**
 * Tests for the task graph (DAG executor).
 */
import { TaskGraph, Task } from '../src/orchestration/task-graph';

function makeTask(id: string, deps: string[], result?: unknown): Task {
  return {
    id,
    name: `Task ${id}`,
    dependencies: deps,
    fn: async (inputs) => result ?? { id, inputs },
  };
}

describe('TaskGraph', () => {
  it('executes a single task', async () => {
    const graph = new TaskGraph();
    graph.addTask(makeTask('a', [], 'result-a'));
    const results = await graph.execute();
    expect(results['a']).toEqual('result-a');
  });

  it('executes tasks in dependency order', async () => {
    const order: string[] = [];
    const graph = new TaskGraph();
    graph.addTask({
      id: 'a',
      name: 'A',
      dependencies: [],
      fn: async () => { order.push('a'); return 'va'; },
    });
    graph.addTask({
      id: 'b',
      name: 'B',
      dependencies: ['a'],
      fn: async (inputs) => { order.push('b'); return inputs['a']; },
    });
    await graph.execute();
    expect(order.indexOf('a')).toBeLessThan(order.indexOf('b'));
  });

  it('passes upstream outputs as inputs to downstream tasks', async () => {
    const graph = new TaskGraph();
    graph.addTask({ id: 'x', name: 'X', dependencies: [], fn: async () => 42 });
    graph.addTask({ id: 'y', name: 'Y', dependencies: ['x'], fn: async (inputs) => (inputs['x'] as number) * 2 });
    const results = await graph.execute();
    expect(results['y']).toEqual(84);
  });

  it('runs independent tasks (implicitly parallel)', async () => {
    const graph = new TaskGraph();
    graph.addTask(makeTask('a', [], 1));
    graph.addTask(makeTask('b', [], 2));
    graph.addTask(makeTask('c', [], 3));
    const results = await graph.execute();
    expect(results['a']).toEqual(1);
    expect(results['b']).toEqual(2);
    expect(results['c']).toEqual(3);
  });

  it('throws on duplicate task id', () => {
    const graph = new TaskGraph();
    graph.addTask(makeTask('dup', []));
    expect(() => graph.addTask(makeTask('dup', []))).toThrow('Duplicate task id');
  });

  it('detects circular dependencies', async () => {
    const graph = new TaskGraph();
    graph.addTask(makeTask('a', ['b']));
    graph.addTask(makeTask('b', ['a']));
    await expect(graph.execute()).rejects.toThrow(/circular|cycle/i);
  });

  it('propagates failure from a failed task (result contains error or rejects)', async () => {
    const graph = new TaskGraph();
    graph.addTask({
      id: 'fail',
      name: 'Fail',
      dependencies: [],
      fn: async () => { throw new Error('task failed'); },
    });
    graph.addTask({ id: 'after', name: 'After', dependencies: ['fail'], fn: async () => 'ok' });
    // The graph may reject OR return with error values — either is acceptable
    let threwOrContainedError = false;
    try {
      const results = await graph.execute();
      // If it didn't throw, the downstream task should have received an error
      const afterResult = results['after'];
      if (afterResult instanceof Error || results['fail'] instanceof Error) {
        threwOrContainedError = true;
      }
    } catch {
      threwOrContainedError = true;
    }
    expect(threwOrContainedError).toBe(true);
  });

  it('getStatus returns status for all tasks', async () => {
    const graph = new TaskGraph();
    graph.addTask(makeTask('s1', [], 'done'));
    await graph.execute();
    const status = graph.getStatus();
    expect(status['s1']).toEqual('completed');
  });
});
