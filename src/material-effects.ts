// One private material per mesh, shared by the Chroma Key and Magic Window effects.
// This prevents the components from repeatedly cloning each other's materials.
export type Uniform<T> = {value: T}
export type EffectShader = {
  uniforms: Record<string, Uniform<unknown>>
  vertexShader: string
  fragmentShader: string
}
export type EffectMaterial = {
  map?: {isVideoTexture?: boolean; image?: {tagName?: string}}
  transparent: boolean
  depthWrite: boolean
  colorWrite: boolean
  needsUpdate: boolean
  clone: () => EffectMaterial
  dispose: () => void
  onBeforeCompile: (shader: EffectShader, renderer: unknown) => void
  customProgramCacheKey: () => string
}
export type EffectMesh = {
  isMesh?: boolean
  visible?: boolean
  material: EffectMaterial | EffectMaterial[]
  onBeforeRender: (...args: unknown[]) => void
}
type Overrides = Partial<Pick<EffectMaterial, 'transparent' | 'depthWrite' | 'colorWrite'>>
export type MaterialEffect = {
  cacheKey: string
  properties?: Overrides
  compile?: (shader: EffectShader) => void
  beforeRender?: (camera: unknown) => void
}
type Binding = {
  original: EffectMaterial
  material: EffectMaterial
  effects: Map<string, MaterialEffect>
  overridden: Set<keyof Overrides>
  originalBeforeRender: EffectMesh['onBeforeRender']
  beforeRender: EffectMesh['onBeforeRender']
}

const bindings = new WeakMap<EffectMesh, Binding>()

const applyProperties = (binding: Binding) => {
  for (const key of binding.overridden) binding.material[key] = binding.original[key]
  binding.overridden.clear()
  for (const effect of binding.effects.values()) {
    for (const key of Object.keys(effect.properties || {}) as Array<keyof Overrides>) {
      binding.material[key] = effect.properties[key]
      binding.overridden.add(key)
    }
  }
}

const cloneMaterial = (binding: Binding, original: EffectMaterial) => {
  binding.original = original
  const material = original.clone()
  const originalCacheKey = typeof original.customProgramCacheKey === 'function' ? original.customProgramCacheKey() : ''
  material.onBeforeCompile = (shader, renderer) => {
    if (typeof original.onBeforeCompile === 'function') {
      original.onBeforeCompile.call(material, shader, renderer)
    }
    for (const effect of binding.effects.values()) effect.compile?.(shader)
  }
  material.customProgramCacheKey = () => [
    originalCacheKey, ...Array.from(binding.effects.values(), effect => effect.cacheKey),
  ].join('|')
  binding.material = material
  applyProperties(binding)
  material.needsUpdate = true
}

export const setMaterialEffect = (mesh: EffectMesh, id: string, effect: MaterialEffect) => {
  try {
    if (!mesh.material || Array.isArray(mesh.material)) return
    let binding = bindings.get(mesh)
    if (!binding) {
      const originalBeforeRender = mesh.onBeforeRender
      binding = {
        original: mesh.material,
        material: mesh.material,
        effects: new Map([[id, effect]]),
        overridden: new Set(),
        originalBeforeRender,
        beforeRender: (...args) => {
          originalBeforeRender?.apply(mesh, args)
          for (const item of binding.effects.values()) item.beforeRender?.(args[2])
        },
      }
      cloneMaterial(binding, mesh.material)
      bindings.set(mesh, binding)
      mesh.material = binding.material
      mesh.onBeforeRender = binding.beforeRender
      return
    }

    // ECS replaces materials when textures or Inspector settings change.
    if (mesh.material !== binding.material) {
      binding.material.dispose()
      cloneMaterial(binding, mesh.material)
      mesh.material = binding.material
    }
    if (binding.effects.get(id) !== effect) {
      binding.effects.set(id, effect)
      applyProperties(binding)
      binding.material.needsUpdate = true
    }
  } catch (err) {
    console.warn('setMaterialEffect warning:', err)
  }
}

export const removeMaterialEffect = (
  mesh: EffectMesh, id: string, expected?: MaterialEffect
) => {
  const binding = bindings.get(mesh)
  if (!binding || (expected && binding.effects.get(id) !== expected)) return
  if (!binding.effects.delete(id)) return

  if (binding.effects.size) {
    applyProperties(binding)
    binding.material.needsUpdate = true
    return
  }
  if (mesh.material === binding.material) mesh.material = binding.original
  if (mesh.onBeforeRender === binding.beforeRender) mesh.onBeforeRender = binding.originalBeforeRender
  // Maps remain owned by ECS; only dispose of the private material.
  binding.material.dispose()
  bindings.delete(mesh)
}
