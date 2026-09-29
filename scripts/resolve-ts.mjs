export async function resolve(specifier, context, nextResolve) {
  const relative = specifier.startsWith("./") || specifier.startsWith("../");
  const hasExtension = /\.(ts|tsx|js|mjs|cjs|json|css)$/.test(specifier);
  if (relative && !hasExtension) {
    try {
      return await nextResolve(`${specifier}.ts`, context);
    } catch {
      return nextResolve(`${specifier}.tsx`, context);
    }
  }
  return nextResolve(specifier, context);
}
