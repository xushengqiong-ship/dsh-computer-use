export function defineTool(tool) {
  if (!tool.name) throw new Error('defineTool: 缺少 name')
  if (typeof tool.execute !== 'function') throw new Error('defineTool: 缺少 execute')
  if (!tool.output || typeof tool.output.render !== 'function') throw new Error('defineTool: 缺少 output.render')
  return tool
}
