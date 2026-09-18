const pending = new Map<string, { resolve: () => void; reject: (error: Error) => void }>();
const controller = new AbortController();
process.on('disconnect', () => process.exit(1));
process.on('message', (message: any) => {
  if (message.type === 'child-granted') { pending.get(message.id)?.resolve(); pending.delete(message.id); }
  if (message.type === 'child-denied') { pending.get(message.id)?.reject(new Error('子任务已取消')); pending.delete(message.id); }
  if (message.type === 'abort') {
    controller.abort(new Error('用户停止了任务'));
    pending.forEach(item => item.reject(new Error('子任务已取消'))); pending.clear();
  }
});
process.once('message', async (request: any) => {
  try {
    if (request.config) {
      if (request.config.model.provider !== 'mock' && !request.config.model.apiKey) throw new Error('模型凭据缺失；请配置 API Key，或显式选择 mock 模型');
      process.env.CHEESE_RUNTIME_CONFIG = JSON.stringify(request.config);
    }
    const { runTask } = await import('../main.js');
    await runTask(request.messages, {
      signal: controller.signal,
      emit: event => process.send?.({ type: 'event', event }),
      acquireChild: async id => {
        controller.signal.throwIfAborted();
        await new Promise<void>((resolve, reject) => { pending.set(id, { resolve, reject }); process.send?.({ type: 'child-acquire', id }); });
        return () => { process.send?.({ type: 'child-release', id }); };
      },
    });
    process.send?.({ type: 'result', messages: request.messages }, () => process.exit(0));
  } catch (error) {
    process.send?.({ type: 'error', error: error instanceof Error ? error.message : String(error) }, () => process.exit(1));
  }
});
