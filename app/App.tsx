import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Button } from './Button.tsx';

type Priority = 'low' | 'medium' | 'high';
type Category = 'work' | 'life' | 'study' | 'other';
type Filter = 'all' | 'active' | 'done';

interface Todo {
  id: number;
  title: string;
  completed: boolean;
  priority: Priority;
  category: Category;
  createdAt: string;
}

const CATEGORY_MAP: Record<Category, { label: string; color: string }> = {
  work: { label: '工作', color: '#3b82f6' },
  life: { label: '生活', color: '#10b981' },
  study: { label: '学习', color: '#8b5cf6' },
  other: { label: '其他', color: '#6b7280' },
};

const PRIORITY_MAP: Record<Priority, { label: string; color: string; bg: string }> = {
  high: { label: '高优', color: '#ef4444', bg: '#fee2e2' },
  medium: { label: '中优', color: '#f59e0b', bg: '#fef3c7' },
  low: { label: '日常', color: '#10b981', bg: '#d1fae5' },
};

const starterTodos: Todo[] = [
  { id: 1, title: '整理本季度项目规划与技术方案', completed: true, priority: 'high', category: 'work', createdAt: '09:00' },
  { id: 2, title: '完成待办清单网页应用并启动预览', completed: false, priority: 'high', category: 'work', createdAt: '10:30' },
  { id: 3, title: '阅读技术文档 30 分钟', completed: false, priority: 'medium', category: 'study', createdAt: '14:00' },
  { id: 4, title: '慢跑 5 公里或健身锻炼', completed: false, priority: 'low', category: 'life', createdAt: '18:30' },
];

function CheckIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.5 4.2 4.2L19 7" /></svg>;
}

function TrashIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3m3 0-1 13H7L6 7m4 4v5m4-5v5" /></svg>;
}

function PlusIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>;
}

function SearchIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m21 21-4.35-4.35M19 11a8 8 0 1 1-16 0 8 8 0 0 1 16 0z" /></svg>;
}

function EditIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>;
}

function App() {
  const [todos, setTodos] = useState<Todo[]>(() => {
    try {
      const saved = localStorage.getItem('daylist-todos');
      return saved ? JSON.parse(saved) : starterTodos;
    } catch {
      return starterTodos;
    }
  });

  const [filter, setFilter] = useState<Filter>('all');
  const [selectedCategory, setSelectedCategory] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [inputTitle, setInputTitle] = useState('');
  const [inputPriority, setInputPriority] = useState<Priority>('medium');
  const [inputCategory, setInputCategory] = useState<Category>('work');

  const [editingId, setEditingId] = useState<number | null>(null);
  const [editTitle, setEditTitle] = useState('');

  useEffect(() => {
    localStorage.setItem('daylist-todos', JSON.stringify(todos));
  }, [todos]);

  const activeCount = todos.filter(t => !t.completed).length;
  const doneCount = todos.length - activeCount;
  const progress = todos.length ? Math.round((doneCount / todos.length) * 100) : 0;

  const visibleTodos = useMemo(() => {
    return todos.filter(todo => {
      if (filter === 'active' && todo.completed) return false;
      if (filter === 'done' && !todo.completed) return false;
      if (selectedCategory !== 'all' && todo.category !== selectedCategory) return false;
      if (searchQuery.trim() && !todo.title.toLowerCase().includes(searchQuery.trim().toLowerCase())) return false;
      return true;
    });
  }, [todos, filter, selectedCategory, searchQuery]);

  const handleAddTodo = (e: React.FormEvent) => {
    e.preventDefault();
    const title = inputTitle.trim();
    if (!title) return;

    const newTodo: Todo = {
      id: Date.now(),
      title,
      completed: false,
      priority: inputPriority,
      category: inputCategory,
      createdAt: new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(new Date()),
    };

    setTodos(prev => [newTodo, ...prev]);
    setInputTitle('');
  };

  const toggleTodo = (id: number) => {
    setTodos(prev => prev.map(t => t.id === id ? { ...t, completed: !t.completed } : t));
  };

  const removeTodo = (id: number) => {
    setTodos(prev => prev.filter(t => t.id !== id));
  };

  const startEdit = (todo: Todo) => {
    setEditingId(todo.id);
    setEditTitle(todo.title);
  };

  const saveEdit = (id: number) => {
    if (editTitle.trim()) {
      setTodos(prev => prev.map(t => t.id === id ? { ...t, title: editTitle.trim() } : t));
    }
    setEditingId(null);
  };

  const clearDone = () => {
    setTodos(prev => prev.filter(t => !t.completed));
  };

  const todayStr = new Intl.DateTimeFormat('zh-CN', {
    month: 'long',
    day: 'numeric',
    weekday: 'long'
  }).format(new Date());

  return (
    <main className="app-shell">
      <section className="todo-card">
        {/* 顶部导航 */}
        <header className="topbar">
          <div className="brand">
            <span className="brand-mark"><CheckIcon /></span>
            <span>TaskFlow 清单</span>
          </div>
          <span className="date-pill">{todayStr}</span>
        </header>

        {/* 头部进度与欢迎语 */}
        <div className="hero">
          <div>
            <p className="eyebrow">TODAY'S GOALS</p>
            <h1>高效规划每一天，<br /><em>把任务逐一攻克。</em></h1>
          </div>
          <div className="progress-wrap" aria-label={`完成进度 ${progress}%`}>
            <div className="progress-ring" style={{ '--progress': `${progress * 3.6}deg` } as React.CSSProperties}>
              <span>{progress}<small>%</small></span>
            </div>
            <p>已达成 {doneCount}/{todos.length}</p>
          </div>
        </div>

        {/* 添加任务表单 */}
        <form className="add-form" onSubmit={handleAddTodo}>
          <div className="add-form-row">
            <span className="input-plus"><PlusIcon /></span>
            <input
              value={inputTitle}
              onChange={e => setInputTitle(e.target.value)}
              placeholder="输入新的待办事项，按回车添加…"
              aria-label="新待办事项"
            />
          </div>
          <div className="add-form-options">
            <div className="select-group">
              <select
                value={inputCategory}
                onChange={e => setInputCategory(e.target.value as Category)}
                aria-label="选择分类"
              >
                <option value="work">💼 工作</option>
                <option value="life">🌿 生活</option>
                <option value="study">📚 学习</option>
                <option value="other">📌 其他</option>
              </select>
              <select
                value={inputPriority}
                onChange={e => setInputPriority(e.target.value as Priority)}
                aria-label="选择优先级"
              >
                <option value="high">🔴 高优先级</option>
                <option value="medium">🟡 中优先级</option>
                <option value="low">🟢 日常低优</option>
              </select>
            </div>
            <Button type="submit" disabled={!inputTitle.trim()}>添加任务</Button>
          </div>
        </form>

        {/* 搜索与分类快速过滤 */}
        <div className="search-filter-bar">
          <div className="search-box">
            <SearchIcon />
            <input
              type="text"
              placeholder="搜索待办..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
            />
            {searchQuery && (
              <button className="clear-search" onClick={() => setSearchQuery('')} type="button">×</button>
            )}
          </div>
          <div className="category-chips">
            <button
              className={`chip ${selectedCategory === 'all' ? 'active' : ''}`}
              onClick={() => setSelectedCategory('all')}
              type="button"
            >
              全部标签
            </button>
            {(Object.keys(CATEGORY_MAP) as Category[]).map(cat => (
              <button
                key={cat}
                className={`chip ${selectedCategory === cat ? 'active' : ''}`}
                onClick={() => setSelectedCategory(cat)}
                type="button"
              >
                {CATEGORY_MAP[cat].label}
              </button>
            ))}
          </div>
        </div>

        {/* 状态筛选 Tabs */}
        <div className="list-controls">
          <div className="filters" role="tablist" aria-label="筛选待办">
            {([['all', '全部'], ['active', '进行中'], ['done', '已完成']] as [Filter, string][]).map(([value, label]) => (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={filter === value}
                className={filter === value ? 'filter active' : 'filter'}
                onClick={() => setFilter(value)}
              >
                {label}
                <span>{value === 'all' ? todos.length : value === 'active' ? activeCount : doneCount}</span>
              </button>
            ))}
          </div>
          {doneCount > 0 && <Button variant="ghost" onClick={clearDone}>清理已完成</Button>}
        </div>

        {/* 待办列表 */}
        <div className="todo-list" aria-live="polite">
          {visibleTodos.length ? (
            visibleTodos.map(todo => (
              <article className={`todo-item ${todo.completed ? 'is-done' : ''}`} key={todo.id}>
                <button
                  className="check"
                  onClick={() => toggleTodo(todo.id)}
                  aria-label={todo.completed ? '标记为未完成' : '标记为已完成'}
                >
                  {todo.completed && <CheckIcon />}
                </button>

                <div className="todo-content">
                  {editingId === todo.id ? (
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        saveEdit(todo.id);
                      }}
                      className="inline-edit-form"
                    >
                      <input
                        autoFocus
                        value={editTitle}
                        onChange={e => setEditTitle(e.target.value)}
                        onBlur={() => saveEdit(todo.id)}
                      />
                    </form>
                  ) : (
                    <p onDoubleClick={() => startEdit(todo)} onClick={() => toggleTodo(todo.id)}>
                      {todo.title}
                    </p>
                  )}
                  <div className="todo-meta">
                    <span className="category-tag" style={{ color: CATEGORY_MAP[todo.category].color }}>
                      #{CATEGORY_MAP[todo.category].label}
                    </span>
                    <span
                      className="priority-tag"
                      style={{
                        color: PRIORITY_MAP[todo.priority].color,
                        background: PRIORITY_MAP[todo.priority].bg
                      }}
                    >
                      {PRIORITY_MAP[todo.priority].label}
                    </span>
                    <small className="todo-time">{todo.createdAt}</small>
                  </div>
                </div>

                <div className="item-actions">
                  <button
                    className="action-icon-btn"
                    onClick={() => startEdit(todo)}
                    title="编辑任务"
                    aria-label="编辑任务"
                  >
                    <EditIcon />
                  </button>
                  <Button
                    variant="danger"
                    className="delete-button"
                    onClick={() => removeTodo(todo.id)}
                    aria-label={`删除 ${todo.title}`}
                  >
                    <TrashIcon />
                  </Button>
                </div>
              </article>
            ))
          ) : (
            <div className="empty-state">
              <span>✓</span>
              <h2>{filter === 'done' ? '暂无已完成的任务' : '没有匹配的待办事项'}</h2>
              <p>{filter === 'active' ? '所有待办都已完成，真棒！' : '可以尝试切换分类、清空搜索或新建任务。'}</p>
            </div>
          )}
        </div>

        {/* 底部统计栏 */}
        <footer>
          <span><i className="status-dot" /> {activeCount ? `剩余 ${activeCount} 项任务进行中` : '所有任务均已达成 ✨'}</span>
          <span>双击文字可快速编辑 · 自动保存到本地</span>
        </footer>
      </section>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
