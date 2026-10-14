import * as ecs from '@8thwall/ecs'
import {setMaterialEffect, removeMaterialEffect} from './material-effects'
import type {EffectMesh, MaterialEffect, Uniform} from './material-effects'

type Binding = {
  mesh: EffectMesh
  effect: MaterialEffect
  uniforms: {
    chromaKeyColor: Uniform<number[]>
    chromaTolerance: Uniform<number>
    chromaSoftness: Uniform<number>
    chromaIsVideo: Uniform<number>
  }
}

const bindings = new WeakMap<ecs.World, Map<bigint, Binding>>()

const CHROMA_FUNCTIONS = `
uniform vec3 chromaKeyColor;
uniform float chromaTolerance;
uniform float chromaSoftness;
uniform float chromaIsVideo;

vec3 chromaLinearToSrgb(vec3 color) {
  return mix(
    12.92 * color,
    1.055 * pow(max(color, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055,
    step(vec3(0.0031308), color)
  );
}

// Compare chrominance in YUV space (Cb, Cr)
vec2 chromaUv(vec3 color) {
  return vec2(
    dot(color, vec3(-0.168736, -0.331264, 0.5)),
    dot(color, vec3(0.5, -0.418688, -0.081312))
  );
}
`

const CHROMA_FRAGMENT = `
#include <map_fragment>
#ifdef USE_MAP
  // For video textures, sampledDiffuseColor is already sRGB.
  // Only convert from linear if it's an sRGB image texture.
  vec3 chromaSample = sampledDiffuseColor.rgb;
  if (chromaIsVideo < 0.5) {
    chromaSample = chromaLinearToSrgb(sampledDiffuseColor.rgb);
  }
  // Discard empty/uninitialized video texture pixels so no black rectangle can ever appear
  if (chromaIsVideo > 0.5 && chromaSample.r < 0.005 && chromaSample.g < 0.005 && chromaSample.b < 0.005) {
    discard;
  }

  vec2 sampleUv = chromaUv(chromaSample);
  vec2 keyUv = chromaUv(chromaKeyColor);
  float chromaDistance = distance(sampleUv, keyUv);

  // Channel dominance protection:
  // If keying green, protect pixels that are predominantly red/blue (e.g. brown, yellow, beige seeds).
  if (chromaKeyColor.g > chromaKeyColor.r && chromaKeyColor.g > chromaKeyColor.b) {
    float greenDominance = chromaSample.g - max(chromaSample.r, chromaSample.b);
    if (greenDominance < -0.01) {
      chromaDistance += abs(greenDominance) + 0.15;
    }
  } else if (chromaKeyColor.b > chromaKeyColor.r && chromaKeyColor.b > chromaKeyColor.g) {
    float blueDominance = chromaSample.b - max(chromaSample.r, chromaSample.g);
    if (blueDominance < -0.01) {
      chromaDistance += abs(blueDominance) + 0.15;
    }
  }

  float chromaAlpha = smoothstep(
    chromaTolerance, chromaTolerance + chromaSoftness, chromaDistance
  );
  diffuseColor.a *= chromaAlpha;

  // Spill suppression (despill): cleans up green halos on edges of the subject
  if (chromaKeyColor.g > chromaKeyColor.r && chromaKeyColor.g > chromaKeyColor.b) {
    float maxOther = max(diffuseColor.r, diffuseColor.b);
    if (diffuseColor.g > maxOther) {
      diffuseColor.g = mix(maxOther, diffuseColor.g, chromaAlpha);
    }
  } else if (chromaKeyColor.b > chromaKeyColor.r && chromaKeyColor.b > chromaKeyColor.g) {
    float maxOther = max(diffuseColor.r, diffuseColor.g);
    if (diffuseColor.b > maxOther) {
      diffuseColor.b = mix(maxOther, diffuseColor.b, chromaAlpha);
    }
  }

  if (diffuseColor.a < 0.001) discard;
#endif
`

const release = (instances: Map<bigint, Binding>, eid: bigint) => {
  const binding = instances.get(eid)
  if (!binding) return

  removeMaterialEffect(binding.mesh, 'chroma-key', binding.effect)
  instances.delete(eid)
}

const attach = (mesh: EffectMesh): Binding => {
  const uniforms = {
    chromaKeyColor: {value: [85 / 255, 166 / 255, 62 / 255]},
    chromaTolerance: {value: 0.08},
    chromaSoftness: {value: 0.04},
    chromaIsVideo: {value: 1.0},
  }
  const effect: MaterialEffect = {
    cacheKey: 'chroma-key-v2',
    properties: {transparent: true, depthWrite: false},
    compile: (shader) => {
      Object.assign(shader.uniforms, uniforms)
      if (shader.fragmentShader.indexOf('#include <common>') !== -1) {
        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <common>',
          '#include <common>\n' + CHROMA_FUNCTIONS
        )
      } else {
        shader.fragmentShader = CHROMA_FUNCTIONS + shader.fragmentShader
      }
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <map_fragment>', CHROMA_FRAGMENT
      )
    },
  }
  return {mesh, effect, uniforms}
}

// Global one-time listener to guarantee mobile browser playback on first user touch if blocked
if (typeof window !== 'undefined' && !(window as any).__arVideoAutoPlayInit) {
  ;(window as any).__arVideoAutoPlayInit = true
  const tryPlayAll = () => {
    document.querySelectorAll('video').forEach((v) => {
      v.muted = true
      v.playsInline = true
      v.loop = true
      v.play().catch(() => {})
    })
  }
  window.addEventListener('touchstart', tryPlayAll, {passive: true, once: true})
  window.addEventListener('click', tryPlayAll, {passive: true, once: true})
}

ecs.registerComponent({
  name: 'Chroma Key',

  // Attach to a textured plane. Its existing image and UV settings are preserved.
  schema: {
    // @label Enabled
    enabled: ecs.boolean,

    // @group start keyColor:color
    // @label Red
    keyRed: ecs.ui8,
    // @label Green
    keyGreen: ecs.ui8,
    // @label Blue
    keyBlue: ecs.ui8,
    // @group end

    // Higher values remove more colors around the selected background color.
    // @label Tolerance
    // @min 0
    // @max 1
    tolerance: ecs.f32,

    // Width of the transition between transparent and opaque pixels.
    // @label Edge Softness
    // @min 0
    // @max 1
    softness: ecs.f32,
  },

  schemaDefaults: {
    enabled: true,
    keyRed: 85,
    keyGreen: 166,
    keyBlue: 62,
    tolerance: 0.08,
    softness: 0.04,
  },

  tick: (world, {eid, schema}) => {
    try {
      let instances = bindings.get(world)
      if (!instances) {
        instances = new Map()
        bindings.set(world, instances)
      }

      if (!schema.enabled) {
        release(instances, eid)
        return
      }

      const object = world.three.entityToObject.get(eid) as any
      let mesh: EffectMesh | undefined
      if (object?.isMesh) {
        mesh = object as EffectMesh
      } else if (object) {
        object.traverse?.((child: any) => {
          if (!mesh && child.isMesh && child.material?.map) {
            mesh = child as EffectMesh
          }
        })
      }

      let binding = instances.get(eid)

      if (binding && binding.mesh !== mesh) {
        release(instances, eid)
        binding = undefined
      }

      // Retry on subsequent frames while the entity or texture is loading.
      if (!mesh?.isMesh || !mesh.material || Array.isArray(mesh.material) || !mesh.material.map) {
        release(instances, eid)
        return
      }

      const media = (mesh.material as any).map?.image
      const isVideo = Boolean(
        (mesh.material as any).map?.isVideoTexture ||
        media instanceof HTMLVideoElement ||
        media?.tagName === 'VIDEO'
      )

      // Automatic video playback without button + no black frame
      if (isVideo && media instanceof HTMLVideoElement) {
        if (!media.muted) media.muted = true
        if (!media.playsInline) media.playsInline = true
        if (!media.loop) media.loop = true

        if (media.paused) {
          media.play().catch(() => {})
        }

        // Hide mesh until first real video frame is decoded to prevent any black rectangle
        if (media.readyState < 2 || media.currentTime === 0) {
          mesh.visible = false
          return
        }
        mesh.visible = true
      }

      if (!binding) {
        binding = attach(mesh)
        instances.set(eid, binding)
      }
      setMaterialEffect(mesh, 'chroma-key', binding.effect)

      const {uniforms} = binding
      uniforms.chromaIsVideo.value = isVideo ? 1.0 : 0.0
      uniforms.chromaKeyColor.value[0] = schema.keyRed / 255
      uniforms.chromaKeyColor.value[1] = schema.keyGreen / 255
      uniforms.chromaKeyColor.value[2] = schema.keyBlue / 255
      uniforms.chromaTolerance.value = Math.max(0, Math.min(1, schema.tolerance))
      // Avoid undefined smoothstep behavior when both edges are equal.
      uniforms.chromaSoftness.value = Math.max(0.0001, Math.min(1, schema.softness))
    } catch (err) {
      console.warn('ChromaKey tick warning:', err)
    }
  },

  remove: (world, {eid}) => {
    const instances = bindings.get(world)
    if (instances) release(instances, eid)
  },
})
