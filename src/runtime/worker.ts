process.once('message', async (request: any) => {
  try {
    if (request.config) process.env.CHEESE_RUNTIME_CONFIG = JSON.stringify(request.config);
    const { runTask } = await import('../main.js');
    await runTask(request.messages);
    process.send?.({ type: 'result', messages: request.messages }, () => process.exit(0));
  } catch (error) {
    process.send?.({ type: 'error', error: error instanceof Error ? error.message : String(error) }, () => process.exit(1));
  }
});
