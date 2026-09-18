process.once('message', async (request: any) => {
  try {
    if (request.config) {
      if (request.config.model.provider !== 'mock' && !request.config.model.apiKey) throw new Error('模型凭据缺失；请配置 API Key，或显式选择 mock 模型');
      process.env.CHEESE_RUNTIME_CONFIG = JSON.stringify(request.config);
    }
    const { runTask } = await import('../main.js');
    await runTask(request.messages);
    process.send?.({ type: 'result', messages: request.messages }, () => process.exit(0));
  } catch (error) {
    process.send?.({ type: 'error', error: error instanceof Error ? error.message : String(error) }, () => process.exit(1));
  }
});
