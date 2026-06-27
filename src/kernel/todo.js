// 任務待辦清單 — kernel 內建（對標 Claude Code 的 TodoWrite）。多步任務時規劃 + 追蹤進度，
// 讓使用者看到 agent 在做什麼。傳入完整清單覆蓋（同 Claude Code 語意）。
const txt = (o) => ({ content: [{ type: 'text', text: typeof o === 'string' ? o : JSON.stringify(o) }] });

export function createTodo() {
  let list = [];
  const tool = {
    name: 'todo_write', label: '待辦', readOnly: true,
    description: '建立/更新任務待辦清單（傳入完整清單覆蓋）。3 步以上的任務建議用它規劃並隨進度更新狀態；'
      + '同時最多一個 in_progress。status：pending | in_progress | completed。',
    parameters: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          items: {
            type: 'object',
            properties: { content: { type: 'string' }, status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] } },
            required: ['content', 'status'],
          },
        },
      },
      required: ['todos'],
    },
    execute: async (_id, { todos }) => {
      list = Array.isArray(todos) ? todos.filter((t) => t && typeof t.content === 'string').map((t) => ({ content: t.content, status: t.status || 'pending' })) : [];
      return txt({ ok: true, count: list.length, todos: list });
    },
  };
  return { tool, get: () => list };
}
