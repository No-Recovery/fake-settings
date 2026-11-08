/* ============================================================
 * Liquid Glass — WebGL port of liquid_glass_easy 4.2.0
 * ------------------------------------------------------------
 * Renders the Apple-style liquid-glass pill (the search bar)
 * with a live refraction of the scrolling backdrop behind it.
 *
 * Shader source: ported from liquid_glass_easy 4.2.0 GLSL
 *   (gradient method = ANALYTIC, the Skia/web-safe variant —
 *    no dFdx). Tested GLSL ES 1.00 (WebGL 1).
 * ============================================================ */
(function () {
    'use strict';

    // ---- Bootstrap ----
    // The UI (#v-main / .search-glass) is built at runtime by buildAll() on
    // DOMContentLoaded, so we cannot look it up while this IIFE runs. Poll
    // until both the capability and the DOM node exist, then start.
    var htmlToImageReady = !!(window.htmlToImage && window.htmlToImage.toCanvas);
    var webglReady = !!window.WebGLRenderingContext;

    var lgDebug = !!window.LG_DEBUG;
    function dbg() {
        if (lgDebug && window.console) {
            window.console.log.apply(window.console, arguments);
        }
    }

    var VIEW = null;
    var GLASS = null;

    // ---- Visible diagnostics ----
    // Shows a small badge on/near the pill explaining why the glass is off.
    // Only appears when window.LG_DEBUG is true or URL has ?lg=1.
    var visDiag = !!(window.LG_DEBUG);
    if (!visDiag) {
        try { visDiag = (/[?&]lg=1/.test(window.location.search)); } catch (e) {}
    }
    function diag(msg) {
        dbg('lg: ' + msg);
        if (!visDiag || !GLASS) return;
        var d = document.getElementById('lg-diag');
        if (!d) {
            d = document.createElement('div');
            d.id = 'lg-diag';
            d.style.cssText =
                'position:fixed;left:10px;bottom:10px;z-index:99999;' +
                'background:rgba(0,0,0,0.85);color:#4cd964;font:12px/1.4 -apple-system,sans-serif;' +
                'padding:8px 12px;border-radius:8px;max-width:72vw;pointer-events:auto;cursor:pointer;';
            d.addEventListener('click', function () {
                if (d.parentNode) d.parentNode.removeChild(d);
            });
            document.body.appendChild(d);
        }
        d.textContent = 'LiquidGlass: ' + msg;
    }

    function findGlass() {
        if (!VIEW) return null;
        var hs = VIEW.querySelector('.home-search');
        if (!hs) return null;
        return hs.querySelector('.search-glass');
    }

    function start() {
        // WebGL-рендер отключён: на устройствах пользователя он рисовал
        // чёрный/некорректный результат. Ликвид-гласс теперь — чистый CSS
        // (backdrop-filter + анимированный блик) в style.css.
        dbg('lg: webgl disabled, css liquid glass active');
        return;
        // ----------------------------------------------------------
        // Tunables (map 1:1 to the Dart painter defaults)
        // ----------------------------------------------------------
    var cfg = {
        magnification: 1.05,
        distortion: 0.35,
        distortionThicknessPx: 6,    // logical px
        cornerRadius: 27,            // logical px (.search-glass border-radius)
        cornerStyle: 2,              // 2 = continuous (Apple capsule)
        borderWidth: 0.4,            // logical px (whisper rim, not an outline)
        borderSoftness: 1.6,         // logical px
        borderAlpha: 0.35,
        lightIntensity: 1.3,
        lightColor: [1.0, 0.98, 0.95, 1.0],
        shadowColor: [0.10, 0.16, 0.38, 0.4],
        lensColor: [1.0, 1.0, 1.0, 0.0],
        oneSideLightIntensity: 0.7,
        chromaticAberration: 0.004,  // UV units
        saturation: 1.3,
        lightMode: 0,                // LIGHT_NORMAL_EDGE
        refractionMode: 1,           // 1 = RADIAL
        refractionType: 1,           // 1 = OPTICAL (Snell)
        refractionIndex: 1.2,
        ambientIntensity: 0.6,
        doubleSideLightIntensity: 0.2,
        borderSaturation: 1.0,
        borderSolidity: 0.5,
        borderMode: 1,               // 1 = OPTICAL (Apple rim)
        lightSpread: 0.7,
        lightSpeedDeg: 18,           // per second, drives the "перелив"
        honorBackdropAlpha: 0
    };

    var cap = Math.max(1, Math.min(window.devicePixelRatio || 1, 2));
    if (window.LG_SCALE) cap = Math.max(1, +window.LG_SCALE);

    // ----------------------------------------------------------
    // Shader — faithful GLSL ES 1.00 port of liquid_glass.frag
    // (LIQUID_GLASS_SKIA path: ANALYTIC gradient, no GLES flip)
    // ----------------------------------------------------------

    var VERT_SRC =
        'attribute vec2 aPos;\n' +
        'void main() {\n' +
        '    gl_Position = vec4(aPos, 0.0, 1.0);\n' +
        '}\n';

    var FRAG_SRC = [
        'precision highp float;',

        'const float EPS = 1e-6;',
        'const float EPS_T = 1e-3;',
        'const float PI = 3.14159265;',

        // ---------- uniforms (declared before use in helpers) ----------
        'uniform vec2  u_resolution;',
        'uniform vec2  u_touch;',
        'uniform sampler2D u_texture_input;',
        'uniform vec4 u_lensGeom;',
        'uniform vec4 u_warp;',
        'uniform float u_diagonalFlip;',
        'uniform float u_borderWidth;',
        'uniform float u_borderSoftness;',
        'uniform vec4  u_borderColor;',
        'uniform float u_borderAlpha;',
        'uniform float u_lightIntensity;',
        'uniform vec4  u_lightColor;',
        'uniform vec4  u_shadowColor;',
        'uniform float u_lightDirection;',
        'uniform vec4 u_lensColor;',
        'uniform vec4 u_packA;',
        'uniform vec4 u_packB;',
        'uniform vec4 u_packC;',
        'uniform float u_lightSpread;',
        'uniform vec2 u_imageOffset;',
        'uniform vec2 u_imageSize;',
        'uniform float u_honorBackdropAlpha;',
        'uniform float u_shapeAaPx;',
        'uniform vec2 u_shapeScale;',
        'uniform vec4 u_xformRow;',
        'uniform vec2 u_xformOff;',

        // --- #define aliases (restore original scalar names) ---
        '#define u_lensWidth                    u_lensGeom.x',
        '#define u_lensHeight                   u_lensGeom.y',
        '#define u_cornerRadius                 u_lensGeom.z',
        '#define u_cornerStyle                  u_lensGeom.w',
        '#define u_magnification                u_warp.x',
        '#define u_distortion                   u_warp.y',
        '#define u_distortionThicknessPx        u_warp.z',
        '#define u_enableBackgroundTransparency u_warp.w',
        '#define u_oneSideLightIntensity        u_packA.x',
        '#define u_chromaticAberration          u_packA.y',
        '#define u_saturation                   u_packA.z',
        '#define u_lightMode                    u_packA.w',
        '#define u_refractionMode               u_packB.x',
        '#define u_refractionType               u_packB.y',
        '#define u_refractionIndex              u_packB.z',
        '#define u_ambientIntensity             u_packB.w',
        '#define u_doubleSideLightIntensity     u_packC.x',
        '#define u_borderSaturation             u_packC.y',
        '#define u_borderSolidity               u_packC.z',
        '#define u_borderMode                   u_packC.w',

        'struct ShapeData {',
        '    float sdf;',
        '    vec2  grad;',
        '    vec2  normal;',
        '    float orthoDist;',
        '};',

        // ---------- lq_common.glsl : helpers ----------
        'vec2 safe2(vec2 v) { return max(v, vec2(EPS)); }',
        'float safe1(float v) { return max(v, EPS); }',
        'float fastPow(float x, float n) { return exp2(n * log2(x)); }',

        // ---------- analytic gradient (Skia/web-safe) ----------
        'ShapeData shapeFrom1TapAnalytic(vec2 p, vec2 c, vec2 hsz, float r, float sdfValue) {',
        '    vec2 rel = p - c;',
        '    vec2 sg  = sign(rel);',
        '    vec2 q   = abs(rel) - hsz + r;',
        '    vec2 grad;',
        '    if (q.x > 0.0 && q.y > 0.0) {',
        '        grad = sg * normalize(max(q, vec2(EPS)));',
        '    } else if (q.x > q.y) {',
        '        grad = vec2(sg.x, 0.0);',
        '    } else {',
        '        grad = vec2(0.0, sg.y);',
        '    }',
        '    float gL = max(length(grad), EPS);',
        '    ShapeData o;',
        '    o.sdf       = sdfValue;',
        '    o.grad      = grad;',
        '    o.normal    = grad / gL;',
        '    o.orthoDist = sdfValue / gL;',
        '    return o;',
        '}',

        // ---------- rounded rectangle SDF ----------
        'float roundedRectangleShape(vec2 p, vec2 c, vec2 h, float r) {',
        '    vec2 q = abs(p - c) - h + r;',
        '    return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - r;',
        '}',

        // ---------- squircle (Ln-norm) SDF ----------
        'float squircleShape(vec2 p, vec2 c, vec2 h, float zone, float n) {',
        '    vec2 q = abs(p - c) - h + zone;',
        '    vec2 m = max(q, vec2(EPS));',
        '    float corner = fastPow(fastPow(m.x, n) + fastPow(m.y, n), 1.0 / n) - zone;',
        '    return min(max(q.x, q.y), 0.0) + corner;',
        '}',

        'ShapeData evaluateShape(vec2 fragPx, vec2 centerPx, vec2 halfSizePx, float radius) {',
        '    return shapeFrom1TapAnalytic(fragPx, centerPx, halfSizePx, radius,',
        '        roundedRectangleShape(fragPx, centerPx, halfSizePx, radius));',
        '}',

        'ShapeData shapeToScreen(ShapeData d, vec2 scale) {',
        '    vec2  g  = d.grad / scale;',
        '    float gL = max(length(g), EPS);',
        '    d.orthoDist *= max(length(d.grad), EPS) / gL;',
        '    d.grad   = g;',
        '    d.normal = g / gL;',
        '    return d;',
        '}',

        'vec2 squircleCornerParams(float r, float smoothing, float maxCorner) {',
        '    float zone  = min(r * (1.0 + 0.528 * smoothing), maxCorner);',
        '    float base  = 1.0 - 0.29289322 * (r / max(zone, EPS));',
        '    float n     = -1.0 / log2(clamp(base, 0.5, 1.0 - EPS));',
        '    return vec2(zone, n);',
        '}',

        'ShapeData evaluateSquircleRRect(vec2 fragPx, vec2 centerPx, vec2 halfSizePx, float zone, float n) {',
        '    return shapeFrom1TapAnalytic(fragPx, centerPx, halfSizePx, zone,',
        '        squircleShape(fragPx, centerPx, halfSizePx, zone, n));',
        '}',

        // ---------- continuous (Apple capsule) corners ----------
        'const float CRR_REACH    = 0.2893;',
        'const float CRR_EXP_RISE = 0.7198;',
        'const float CRR_ROOM_SHAPE = 0.6;',
        'const float CRR_EPS      = 1e-6;',
        'const float CRR_DEGEN    = 1e-20;',

        'vec2 continuousRoundedRectReach(float rr, vec2 halfSize) {',
        '    vec2 t = clamp((halfSize - vec2(rr)) / max(rr, CRR_EPS), 0.0, 1.0);',
        '    return rr * min(CRR_REACH * pow(t, vec2(CRR_ROOM_SHAPE)), t);',
        '}',

        'float continuousRoundedRectShape(vec2 p, vec2 c, vec2 hsz, float rr, vec2 reach) {',
        '    vec2 a = abs(p - c);',
        '    vec2 e = a - hsz;',
        '    float box = min(max(e.x, e.y), 0.0) + length(max(e, vec2(0.0)));',
        '    vec2 R = min(vec2(rr) + reach, hsz);',
        '    vec2 q = a - (hsz - R);',
        '    if (min(q.x, q.y) <= 0.0) return box;',
        '    vec2  n = vec2(2.0) + CRR_EXP_RISE * reach / max(CRR_REACH * rr, CRR_EPS);',
        '    vec2  t = pow(q / R, n);',
        '    float S = t.x + t.y;',
        '    if (S <= CRR_DEGEN) return box;',
        '    vec2  w = t / S;',
        '    float corner = dot(R, w) * (pow(S, 1.0 / dot(n, w)) - 1.0);',
        '    return max(corner, box);',
        '}',

        'ShapeData evaluateContinuousRoundedRect(',
        '    vec2 fragPx, vec2 centerPx, vec2 halfSizePx, float rr, vec2 reach) {',
        '    return shapeFrom1TapAnalytic(fragPx, centerPx, halfSizePx, rr,',
        '        continuousRoundedRectShape(fragPx, centerPx, halfSizePx, rr, reach));',
        '}',

        // ---------- refraction ----------
        'vec2 refractFromAnchorPx(vec2 frag, vec2 anchor, float df, float mag, float flip, float t) {',
        '    vec2 v = frag - anchor;',
        '    float s = max(df, EPS);',
        '    vec2 refr = anchor + v / s;',
        '    float k = smoothstep(1.0 - flip, 1.0, t);',
        '    vec2 flipped = anchor - (refr - anchor);',
        '    return mix(refr, flipped, k);',
        '}',

        'vec2 computeInsetAnchor(vec2 fragPx, vec2 normal, float sdf, float insetPx) {',
        '    return fragPx - normal * (sdf + insetPx);',
        '}',

        'float computeDistortionFactor(float distortionAmt, float t) {',
        '    float d = clamp(distortionAmt, 0.0, 1.0) * 100.0;',
        '    return 1.0 + d * pow(t, d);',
        '}',

        'vec2 computeShapeRefraction(',
        '    vec2 fragPx, vec2 normal, float sdf, float insetPx,',
        '    float distortionFactor, float magnification, float diagonalFlip, float zoneT) {',
        '    vec2 anchor = computeInsetAnchor(fragPx, normal, sdf, insetPx);',
        '    return refractFromAnchorPx(fragPx, anchor, distortionFactor,',
        '        magnification, diagonalFlip, zoneT);',
        '}',

        'const float REFRACTION_DEPTH_SCALE = 1.0;',

        'vec2 computeRefractedPosition(',
        '    vec2 fragPx, vec2 normal2D, float sdf, float thickness,',
        '    float refractiveIndex, float strength, float zoneT) {',
        '    float h     = clamp(-sdf / max(thickness, EPS), 0.0, 1.0);',
        '    float bulge = sqrt(max(1.0 - h * h, 0.0));',
        '    vec3  normal3D = normalize(vec3(normal2D * bulge, h));',
        '    vec3  I   = vec3(0.0, 0.0, -1.0);',
        '    float eta = 1.0 / max(refractiveIndex, 1.0);',
        '    vec3 refr = refract(I, normal3D, eta);',
        '    float depth = thickness * strength * 5.0 * REFRACTION_DEPTH_SCALE * zoneT;',
        '    return fragPx + refr.xy * depth;',
        '}',

        'vec2 applyLensMagnification(vec2 fragPx, vec2 lensCenterPx, float magnification) {',
        '    float m = max(magnification, 0.001);',
        '    return lensCenterPx + (fragPx - lensCenterPx) / m;',
        '}',

        'vec3 applyLensTint(vec3 base, float mask, vec4 color, float borderAlpha) {',
        '    return (color.a > 0.001 && mask > 0.001)',
        '        ? mix(base, color.rgb, color.a * borderAlpha * mask)',
        '        : base;',
        '}',

        // ---------- border --------------------------------
        'const vec3 BORDER_LUMA = vec3(0.2126, 0.7152, 0.0722);',

        'vec3 getHighlightColor(vec3 bgColor, float targetBrightness) {',
        '    float luminance = dot(bgColor, BORDER_LUMA);',
        '    vec3 saturatedBg = bgColor / max(luminance, 0.001);',
        '    saturatedBg = mix(bgColor, saturatedBg, 0.8);',
        '    float colorfulness = length(bgColor - vec3(luminance));',
        '    float colorMix = clamp(colorfulness + 0.5, 0.5, 1.0);',
        '    vec3 highlight = mix(vec3(targetBrightness), saturatedBg, colorMix);',
        '    return clamp(highlight, 0.0, 1.0);',
        '}',

        'float getLensHeight(float sd, float thickness) {',
        '    if (sd >= 0.0 || thickness <= 0.0) return 0.0;',
        '    if (sd < -thickness) return thickness;',
        '    float x = thickness + sd;',
        '    return sqrt(max(0.0, thickness * thickness - x * x));',
        '}',

        'vec4 getClassicBorder(',
        '    vec2 uvNorm, vec2 centerNorm, float signedEdgeOrthoDistPx, vec2 gradDistPx,',
        '    float borderWidthPx, float softnessPx, vec4 tint,',
        '    vec4 lightColor, vec4 shadowColor, float lightIntensity,',
        '    float borderAlpha, float lightDirDeg,',
        '    float oneSideLightIntensity, float lightMode,',
        '    float doubleSideLightIntensity) {',
        '    if (borderWidthPx <= 0.0 || borderAlpha <= 0.0) return vec4(0.0);',
        '    float halfW = borderWidthPx * 0.5;',
        '    if (signedEdgeOrthoDistPx > halfW) return vec4(0.0);',
        '    float mask = 1.0 - smoothstep(',
        '        halfW, halfW + max(softnessPx, 1e-3), abs(signedEdgeOrthoDistPx));',
        '    if (mask <= 0.001) return vec4(0.0);',
        '    vec2 normal;',
        '    if (lightMode == 0.0) {',
        '        normal = normalize(gradDistPx);',
        '    } else {',
        '        normal = normalize(uvNorm - centerNorm);',
        '    }',
        '    float ang = atan(normal.y, normal.x);',
        '    float lightRad = radians(lightDirDeg);',
        '    ang -= radians(lightDirDeg);',
        '    ang = mod(ang, 2.0 * PI);',
        '    float tAngle = ang / (2.0 * PI);',
        '    vec4 c0, c1;',
        '    if (tint.a > 0.0) {',
        '        c0 = tint;',
        '        c1 = tint;',
        '    } else {',
        '        c0 = lightColor;',
        '        c1 = shadowColor;',
        '    }',
        '    vec4 col =',
        '        (tAngle <= 0.25) ? mix(c0, c1, tAngle / 0.25) :',
        '        (tAngle <= 0.50) ? mix(c1, c0, (tAngle - 0.25) / 0.25) :',
        '        (tAngle <= 0.75) ? mix(c0, c1, (tAngle - 0.50) / 0.25) :',
        '                           mix(c1, c0, (tAngle - 0.75) / 0.25);',
        '    if (oneSideLightIntensity > 0.0) {',
        '        vec2 lightDirV = vec2(cos(lightRad), sin(lightRad));',
        '        float spec = max(dot(normal, lightDirV), 0.0);',
        '        spec = pow(spec, 8.0);',
        '        col.rgb += lightColor.rgb * spec * lightIntensity * (0.8 * oneSideLightIntensity);',
        '    }',
        '    if (doubleSideLightIntensity > 0.0) {',
        '        vec2 lightDirV = vec2(cos(lightRad), sin(lightRad));',
        '        float specFront = max(dot(normal, lightDirV), 0.0);',
        '        specFront = pow(specFront, 8.0);',
        '        float specBack = max(dot(normal, -lightDirV), 0.0);',
        '        specBack = pow(specBack, 8.0);',
        '        col.rgb += lightColor.rgb * (specFront + specBack) * lightIntensity * (0.8 * doubleSideLightIntensity);',
        '    }',
        '    col.rgb *= lightIntensity;',
        '    float a = col.a * borderAlpha * mask;',
        '    return vec4(col.rgb * a, a);',
        '}',

        'vec4 getOpticalBorder(',
        '    vec2 uvNorm, vec2 centerNorm, float signedEdgeOrthoDistPx, vec2 gradDistPx,',
        '    float borderWidthPx, float softnessPx, vec4 tint,',
        '    vec4 lightColor, vec4 shadowColor, float lightIntensity,',
        '    float borderAlpha, float lightDirDeg,',
        '    float oneSideLightIntensity, float lightMode,',
        '    vec3 ambientColor, float ambientIntensity,',
        '    float doubleSideLightIntensity, float borderSaturation,',
        '    float borderSolidity, float lightSpread) {',
        '    if (borderWidthPx <= 0.0 || borderAlpha <= 0.0) return vec4(0.0);',
        '    float sd = signedEdgeOrthoDistPx;',
        '    float rimWidth = max(borderWidthPx, 1.0);',
        '    float k = 0.89;',
        '    float x = sd / rimWidth;',
        '    float rimFactor = 1.0 / (1.0 + k * x * x);',
        '    float innerFade = 1.0 - smoothstep(',
        '        borderWidthPx * 1.5, borderWidthPx * 3.0, max(-sd, 0.0));',
        '    rimFactor *= innerFade;',
        '    float outerFade = 1.0 - smoothstep(0.0, max(softnessPx, 1.0), max(sd, 0.0));',
        '    rimFactor *= outerFade;',
        '    if (rimFactor <= 0.001) return vec4(0.0);',
        '    vec2 normal;',
        '    if (lightMode == 0.0) {',
        '        normal = normalize(gradDistPx);',
        '    } else {',
        '        normal = normalize(uvNorm - centerNorm);',
        '    }',
        '    float lightRad = radians(lightDirDeg);',
        '    vec2 lightDirV = vec2(cos(lightRad), sin(lightRad));',
        '    float thickness = borderWidthPx;',
        '    float height = getLensHeight(sd, thickness);',
        '    float normalizedHeight = thickness > 0.0 ? height / thickness : 0.0;',
        '    float shapeMask = clamp((1.0 - normalizedHeight) * 1.111, 0.0, 1.0);',
        '    float thicknessFactor = clamp((thickness - 2.0) * 0.5, 0.0, 1.0);',
        '    vec3 highlightCol = vec3(1.0);',
        '    if (dot(ambientColor, ambientColor) > 1e-5) {',
        '        highlightCol = getHighlightColor(ambientColor, 1.0);',
        '    }',
        '    highlightCol *= lightColor.rgb;',
        '    if (tint.a > 0.0) {',
        '        highlightCol = mix(highlightCol, tint.rgb, clamp(tint.a, 0.0, 1.0));',
        '    }',
        '    if (borderSaturation != 1.0) {',
        '        float rimLuma = dot(highlightCol, BORDER_LUMA);',
        '        highlightCol = mix(vec3(rimLuma), highlightCol, borderSaturation);',
        '    }',
        '    float spread = clamp(lightSpread, 0.0, 1.0);',
        '    float spreadExp = mix(2.5, 0.5, spread);',
        '    float lobeCut = (0.5 - min(spread, 0.5)) * 1.7;',
        '    float mainLight = max(dot(normal, lightDirV), 0.0);',
        '    float oppositeLight = max(dot(normal, -lightDirV), 0.0);',
        '    mainLight = clamp((mainLight - lobeCut) / (1.0 - lobeCut), 0.0, 1.0);',
        '    oppositeLight = clamp((oppositeLight - lobeCut) / (1.0 - lobeCut), 0.0, 1.0);',
        '    float totalInfluence = mainLight + oppositeLight;',
        '    float directional = pow(totalInfluence, spreadExp) * lightIntensity * 3.0;',
        '    float ambient = ambientIntensity * 0.1;',
        '    float lightStrength = directional + ambient;',
        '    if (oneSideLightIntensity > 0.0) {',
        '        float spec1 = max(dot(normal, lightDirV), 0.0);',
        '        spec1 = pow(spec1, 8.0);',
        '        lightStrength += spec1 * lightIntensity * (0.8 * oneSideLightIntensity);',
        '    }',
        '    if (doubleSideLightIntensity > 0.0) {',
        '        float sf = max(dot(normal, lightDirV), 0.0);',
        '        sf = pow(sf, 8.0);',
        '        float sb = max(dot(normal, -lightDirV), 0.0);',
        '        sb = pow(sb, 8.0);',
        '        lightStrength += (sf + sb) * lightIntensity * (0.8 * doubleSideLightIntensity);',
        '    }',
        '    float cappedLight = clamp(lightStrength, 0.0, 1.0);',
        '    float effectiveLight = mix(cappedLight, lightStrength, clamp(borderSolidity, 0.0, 1.0));',
        '    float spatialMask = rimFactor * thicknessFactor * shapeMask;',
        '    float a = clamp(borderAlpha * effectiveLight * spatialMask, 0.0, 1.0);',
        '    return vec4(highlightCol * a, a);',
        '}',

        'vec4 getSweepBorder(',
        '    vec2 uvNorm, vec2 centerNorm, float signedEdgeOrthoDistPx, vec2 gradDistPx,',
        '    float borderWidthPx, float softnessPx, vec4 tint,',
        '    vec4 lightColor, vec4 shadowColor, float lightIntensity,',
        '    float borderAlpha, float lightDirDeg,',
        '    float oneSideLightIntensity, float lightMode,',
        '    vec3 ambientColor, float ambientIntensity,',
        '    float doubleSideLightIntensity, float borderSaturation,',
        '    float borderSolidity, float lightSpread, float borderMode) {',
        '    if (borderMode >= 0.5) {',
        '        return getOpticalBorder(',
        '            uvNorm, centerNorm, signedEdgeOrthoDistPx, gradDistPx,',
        '            borderWidthPx, softnessPx, tint,',
        '            lightColor, shadowColor, lightIntensity,',
        '            borderAlpha, lightDirDeg,',
        '            oneSideLightIntensity, lightMode,',
        '            ambientColor, ambientIntensity,',
        '            doubleSideLightIntensity, borderSaturation,',
        '            borderSolidity, lightSpread);',
        '    } else {',
        '        return getClassicBorder(',
        '            uvNorm, centerNorm, signedEdgeOrthoDistPx, gradDistPx,',
        '            borderWidthPx, softnessPx, tint,',
        '            lightColor, shadowColor, lightIntensity,',
        '            borderAlpha, lightDirDeg,',
        '            oneSideLightIntensity, lightMode,',
        '            doubleSideLightIntensity);',
        '    }',
        '}',

        'vec4 overlayPremulClassic(vec4 base, vec4 over){',
        '    float outA   = over.a + base.a * (1.0 - over.a);',
        '    vec3  outRGB = over.rgb + base.rgb * (1.0 - over.a);',
        '    return vec4(outRGB, outA);',
        '}',

        'vec4 overlayPremulOptical(vec4 base, vec4 over){',
        '    float baseA = base.a;',
        '    float strength = clamp(over.a, 0.0, 1.0);',
        '    if (baseA <= 1e-4 || strength <= 1e-4) {',
        '        return base;',
        '    }',
        '    vec3 baseColor = base.rgb / max(baseA, 1e-4);',
        '    vec3 rimColor = over.rgb / max(over.a, 1e-4);',
        '    vec3 mixedColor = mix(baseColor, rimColor, strength);',
        '    return vec4(mixedColor * baseA, baseA);',
        '}',

        'vec4 overlayPremul(vec4 base, vec4 over, float borderMode){',
        '    if (borderMode >= 0.5) {',
        '        return overlayPremulOptical(base, over);',
        '    } else {',
        '        return overlayPremulClassic(base, over);',
        '    }',
        '}',

        'vec3 applyChromaticAberration(vec2 uv, float shift) {',
        '    vec3 color = texture2D(u_texture_input, uv).rgb;',
        '    if (shift < 0.001) return color;',
        '    float luma = dot(color, vec3(0.2126, 0.7152, 0.0722));',
        '    vec2 offset = vec2(shift * luma);',
        '    float r = texture2D(u_texture_input, uv + offset).r;',
        '    float g = texture2D(u_texture_input, uv).g;',
        '    float b = texture2D(u_texture_input, uv - offset).b;',
        '    return vec3(r, g, b);',
        '}',

        'vec3 applySaturation(vec3 color, float saturation) {',
        '    float luminance = dot(color, vec3(0.299, 0.587, 0.114));',
        '    return mix(vec3(luminance), color, saturation);',
        '}',

        'vec4 finalSample(',
        '    vec2 refractedPx, float shapeMask, float caShift, bool xformed,',
        '    out vec3 preTintColor) {',
        '    vec3 refrColor;',
        '    if (xformed) {',
        '        refractedPx = mat2(u_xformRow.x, u_xformRow.z,',
        '                           u_xformRow.y, u_xformRow.w)',
        '                      * refractedPx + u_xformOff;',
        '    }',
        '    vec2 sampleUV = clamp((refractedPx - u_imageOffset) / u_imageSize,',
        '                          vec2(0.001), vec2(0.999));',
        '    refrColor = applyChromaticAberration(sampleUV, caShift);',
        '    refrColor = applySaturation(refrColor, u_saturation);',
        '    preTintColor = refrColor;',
        '    float texA = (u_honorBackdropAlpha > 0.5)',
        '        ? texture2D(u_texture_input, sampleUV).a',
        '        : 1.0;',
        '    float coverage = shapeMask * texA;',
        '    vec4 base = vec4(refrColor * shapeMask, coverage);',
        '    base.rgb = applyLensTint(base.rgb, shapeMask, u_lensColor, u_borderAlpha);',
        '    return base;',
        '}',

        'float computeShapeMask(float shapeDistPx) {',
        '    float aa = max(u_shapeAaPx, 1.0);',
        '    return 1.0 - smoothstep(-0.5 * aa, 0.5 * aa, shapeDistPx);',
        '}',

        // ---------- main ----------
        'void main() {',
        '    // top-left origin, in capture-px space (WebGL frag coords flip)',
        '    vec2 fragPx = vec2(gl_FragCoord.x, u_resolution.y - gl_FragCoord.y);',

        '    bool xformed = any(notEqual(u_xformRow, vec4(1.0, 0.0, 0.0, 1.0))) ||',
        '                   any(notEqual(u_xformOff, vec2(0.0)));',
        '    if (xformed) {',
        '        float det = u_xformRow.x * u_xformRow.w - u_xformRow.y * u_xformRow.z;',
        '        if (abs(det) < 1e-6) xformed = false;',
        '    }',

        '    float invResY = 1.0 / u_resolution.y;',
        '    vec2 uvNorm   = fragPx * invResY;',
        '    vec2 lensHalfSizePx = 0.5 * vec2(u_lensWidth, u_lensHeight);',
        '    vec2 lensCenterPx   = u_touch + lensHalfSizePx;',
        '    vec2 lensCenterNorm = lensCenterPx * invResY;',

        // --- shape ---
        '    bool deformed = u_shapeScale.x > 0.0 && u_shapeScale.y > 0.0 &&',
        '                    (u_shapeScale.x != 1.0 || u_shapeScale.y != 1.0);',
        '    vec2 shapeScale = deformed ? max(u_shapeScale, vec2(1e-4)) : vec2(1.0);',
        '    vec2 restHalfPx = deformed ? lensHalfSizePx / shapeScale : lensHalfSizePx;',
        '    vec2 fragRestPx = deformed ? lensCenterPx + (fragPx - lensCenterPx) / shapeScale : fragPx;',
        '    float maxCorner      = min(restHalfPx.x, restHalfPx.y);',
        '    float cornerRadiusPx = min(u_cornerRadius, maxCorner);',

        '    ShapeData shapeData;',
        '    if (u_cornerStyle > 1.5 && cornerRadiusPx > 0.5) {',
        '        vec2 reach = continuousRoundedRectReach(cornerRadiusPx, restHalfPx);',
        '        shapeData = evaluateContinuousRoundedRect(',
        '            fragRestPx, lensCenterPx, restHalfPx, cornerRadiusPx, reach);',
        '    } else if (u_cornerStyle > 0.5 && cornerRadiusPx > 0.5) {',
        '        vec2 zn = squircleCornerParams(cornerRadiusPx, 1.0, maxCorner);',
        '        shapeData = evaluateSquircleRRect(',
        '            fragRestPx, lensCenterPx, restHalfPx, zn.x, zn.y);',
        '    } else {',
        '        shapeData = evaluateShape(',
        '            fragRestPx, lensCenterPx, restHalfPx, cornerRadiusPx);',
        '    }',

        '    shapeData   = shapeToScreen(shapeData, shapeScale);',
        '    float shapeDistPx = shapeData.orthoDist;',
        '    float refrDistPx = deformed ? shapeData.orthoDist : shapeData.sdf;',
        '    float shapeMask = computeShapeMask(shapeDistPx);',

        // --- distortion zone ---
        '    float distAbsPx = abs(shapeDistPx);',
        '    float zoneLimit = u_distortionThicknessPx;',
        '    float zoneMask  = step(distAbsPx, zoneLimit);',

        '    vec2 magPx = applyLensMagnification(fragPx, lensCenterPx, u_magnification);',

        '    if (zoneMask < 0.5) {',
        '        // outside distortion zone',
        '        vec3 preTintCol = vec3(0.0);',
        '        vec4 base = (u_enableBackgroundTransparency > 0.5)',
        '        ? vec4(0.0)',
        '        : finalSample(magPx, shapeMask, 0.0, xformed, preTintCol);',
        '        vec3 ambientCol = preTintCol;',
        '        vec4 borderPremul = getSweepBorder(',
        '            uvNorm, lensCenterNorm, shapeData.orthoDist, shapeData.grad,',
        '            u_borderWidth, u_borderSoftness, u_borderColor,',
        '            u_lightColor, u_shadowColor,',
        '            u_lightIntensity, u_borderAlpha, u_lightDirection, u_oneSideLightIntensity, u_lightMode,',
        '            ambientCol, u_ambientIntensity,',
        '            u_doubleSideLightIntensity, u_borderSaturation, u_borderSolidity,',
        '            u_lightSpread, u_borderMode);',
        '        gl_FragColor = overlayPremul(base, borderPremul, u_borderMode);',
        '        return;',
        '    }',

        // --- distortion zone ---
        '    float zoneT = 1.0 - clamp(distAbsPx / max(zoneLimit, EPS), 0.0, 1.0);',
        '    vec2 refrPx;',
        '    if (u_refractionType == 1.0) {',
        '        vec2 opticalNormal = shapeData.normal;',
        '        if (u_refractionMode == 1.0) {',
        '            vec2 radial = magPx - lensCenterPx;',
        '            float radialLength = length(radial);',
        '            if (radialLength > EPS) {',
        '                opticalNormal = radial / radialLength;',
        '            }',
        '        }',
        '        refrPx = computeRefractedPosition(',
        '            magPx, opticalNormal, refrDistPx, u_distortionThicknessPx,',
        '            u_refractionIndex, u_distortion, zoneT);',
        '    } else if (u_refractionMode == 0.0) {',
        '        float distortionFactor = computeDistortionFactor(u_distortion, zoneT);',
        '        refrPx = computeShapeRefraction(',
        '            magPx, shapeData.normal, refrDistPx, u_distortionThicknessPx,',
        '            distortionFactor, u_magnification, u_diagonalFlip, zoneT);',
        '    } else {',
        '        vec2 distortionCenter = lensCenterPx;',
        '        float distortionFactor = computeDistortionFactor(u_distortion, zoneT);',
        '        refrPx = refractFromAnchorPx(',
        '            magPx, distortionCenter, distortionFactor,',
        '            u_magnification, u_diagonalFlip, zoneT);',
        '    }',

        '    vec3 preTintCol2 = vec3(0.0);',
        '    float caShift = u_chromaticAberration * zoneT;',
        '    vec4 base = finalSample(refrPx, shapeMask, caShift, xformed, preTintCol2);',
        '    vec3 ambientCol2 = preTintCol2;',
        '    vec4 borderPremul = getSweepBorder(',
        '        uvNorm, lensCenterNorm, shapeData.orthoDist, shapeData.grad,',
        '        u_borderWidth, u_borderSoftness, u_borderColor,',
        '        u_lightColor, u_shadowColor,',
        '        u_lightIntensity, u_borderAlpha, u_lightDirection, u_oneSideLightIntensity, u_lightMode,',
        '        ambientCol2, u_ambientIntensity,',
        '        u_doubleSideLightIntensity, u_borderSaturation, u_borderSolidity,',
        '        u_lightSpread, u_borderMode);',
        '    gl_FragColor = overlayPremul(base, borderPremul, u_borderMode);',
        '}'
    ].join('\n');

    // ----------------------------------------------------------
    // WebGL setup
    // ----------------------------------------------------------
    var canvas = document.createElement('canvas');
    canvas.className = 'lg-canvas';
    GLASS.insertBefore(canvas, GLASS.firstChild);

    var gl = null;
    try {
        gl = canvas.getContext('webgl', {
            alpha: true,
            antialias: false,
            premultipliedAlpha: true,
            preserveDrawingBuffer: false,
            powerPreference: 'low-power'
        }) || canvas.getContext('experimental-webgl', { alpha: true });
    } catch (e) { /* no gl */ }
    if (!gl) {
        diag('Не удалось создать WebGL-контекст');
        canvas.parentNode.removeChild(canvas);
        return;
    }
    dbg('lg: WebGL OK');

    // Vertex buffer: fullscreen quad
    var buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER,
        new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
        gl.STATIC_DRAW);

    function compile(type, src) {
        var sh = gl.createShader(type);
        gl.shaderSource(sh, src);
        gl.compileShader(sh);
        if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
            throw new Error(gl.getShaderInfoLog(sh));
        }
        return sh;
    }

    var prog = null;
    try {
        var vs = compile(gl.VERTEX_SHADER, VERT_SRC);
        var fs = compile(gl.FRAGMENT_SHADER, FRAG_SRC);
        prog = gl.createProgram();
        gl.attachShader(prog, vs);
        gl.attachShader(prog, fs);
        gl.bindAttribLocation(prog, 0, 'aPos');
        gl.linkProgram(prog);
        if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
            throw new Error(gl.getProgramInfoLog(prog));
        }
        gl.useProgram(prog);
    } catch (e) {
        if (window.console) console.error('liquidglass: shader error', e);
        diag('Ошибка шейдера: ' + (e && e.message ? e.message : e));
        canvas.parentNode.removeChild(canvas);
        return;
    }

    var U = {};
    (function () {
        var names = ['u_resolution', 'u_touch', 'u_texture_input', 'u_lensGeom',
            'u_warp', 'u_diagonalFlip', 'u_borderWidth', 'u_borderSoftness',
            'u_borderColor', 'u_borderAlpha', 'u_lightIntensity', 'u_lightColor',
            'u_shadowColor', 'u_lightDirection', 'u_lensColor', 'u_packA',
            'u_packB', 'u_packC', 'u_lightSpread', 'u_imageOffset',
            'u_imageSize', 'u_honorBackdropAlpha', 'u_shapeAaPx', 'u_shapeScale',
            'u_xformRow', 'u_xformOff'];
        for (var i = 0; i < names.length; i++) {
            U[names[i]] = gl.getUniformLocation(prog, names[i]);
        }
    })();

    var aPos = gl.getAttribLocation(prog, 'aPos');
    gl.enableVertexAttribArray(aPos);
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    // Texture (backdrop)
    var texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.uniform1i(U.u_texture_input, 0);

    dbg('lg: GL ready, uniforms ' + Object.keys(U).length);

    var hasTexture = false;

    function activate() {
        if (!GLASS.classList.contains('lg-active')) {
            GLASS.classList.add('lg-active');
            dbg('lg: glass active');
            diag('работает');
        }
    }

    // Fallback backdrop: do nothing. Without a real captured backdrop the WebGL
// canvas would paint black over the pill, so we leave it transparent and let
// the CSS (backdrop-filter blur + moving sheen) provide the frosted glass.
    function ensureFallback() {
        return;
    }

    // ----------------------------------------------------------
    // Geometry (pill rect within the active view, capture-px space)
    // ----------------------------------------------------------
    function layout() {
        var vrect = VIEW.getBoundingClientRect();
        var grect = GLASS.getBoundingClientRect();
        var pillL = grect.left - vrect.left;
        var pillT = grect.top - vrect.top;
        var pillW = grect.width;
        var pillH = grect.height;
        return {
            l: Math.round(pillL * cap),
            t: Math.round(pillT * cap),
            w: Math.max(1, Math.round(pillW * cap)),
            h: Math.max(1, Math.round(pillH * cap)),
            vw: Math.round(vrect.width * cap),
            vh: Math.round(vrect.height * cap)
        };
    }

    var resizeCanvas = function (w, h) {
        w = Math.max(1, Math.round(w || 1));
        h = Math.max(1, Math.round(h || 1));
        if (canvas.width !== w || canvas.height !== h) {
            canvas.width = w;
            canvas.height = h;
            canvas.style.width = '100%';
            canvas.style.height = '100%';
        }
        gl.viewport(0, 0, canvas.width, canvas.height);
        gl.scissor(0, 0, canvas.width, canvas.height);
    };

    // ----------------------------------------------------------
    // Backdrop capture (html-to-image, scroll-compensated) + crop
    // ----------------------------------------------------------
    var MARGIN_CSS = 30; // px around the pill for refraction spill

    function uploadCanvas(src, w, h) {
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE,
            src);
        hasTexture = true;
    }

    var captureBusy = false;
    var capturePending = false;
    var lastLayout = null;

    function doCapture() {
        if (captureBusy) { capturePending = true; return; }
        captureBusy = true;

        // Only meaningful when v-main (and its pill) is actually visible:
        // offsetParent is null once .view is display:none (sub-page on top)
        if (!GLASS.offsetParent) {   // hidden (display:none chain)
            captureBusy = false;
            return;
        }

        var lay = layout();
        resizeCanvas(lay.w, lay.h);
        var scrollTop = VIEW.scrollTop || 0;

        var viewBg = '';
        try {
            viewBg = window.getComputedStyle(VIEW).backgroundColor || '#F2F2F7';
        } catch (e) {
            viewBg = '#F2F2F7';
        }

        var opts = {
            width: Math.round(VIEW.clientWidth),
            height: Math.round(VIEW.clientHeight),
            pixelRatio: cap,
            backgroundColor: viewBg,
            skipFonts: true,
            style: {
                transform: 'translateY(' + (-scrollTop) + 'px)',
                transition: 'none'
            },
            filter: function (node) {
                if (!node || !node.classList) return true;
                var c = node.classList;
                return !(c.contains('home-search') ||
                         c.contains('search-glass') ||
                         c.contains('lg-canvas'));
            }
        };

        var done = function (ok) {
            captureBusy = false;
            if (ok) activate();
            if (capturePending) {
                capturePending = false;
                doCapture();
            }
        };

        htmlToImage.toCanvas(VIEW, opts).then(function (fullCanvas) {
            dbg('lg: backdrop captured', fullCanvas.width + 'x' + fullCanvas.height,
                'pill', lay.l, lay.t, lay.w, lay.h, 'scroll', scrollTop, 'cap', cap);
            // Crop the pill region (+ margin) out of the full capture
            var x0 = Math.max(0, lay.l - Math.round(MARGIN_CSS * cap));
            var y0 = Math.max(0, lay.t - Math.round(MARGIN_CSS * cap));
            var x1 = Math.min(fullCanvas.width,  lay.l + lay.w + Math.round(MARGIN_CSS * cap));
            var y1 = Math.min(fullCanvas.height, lay.t + lay.h + Math.round(MARGIN_CSS * cap));
            var rw = Math.max(1, x1 - x0);
            var rh = Math.max(1, y1 - y0);

            var crop = document.createElement('canvas');
            crop.width = rw;
            crop.height = rh;
            var cctx = crop.getContext('2d');
            cctx.drawImage(fullCanvas, x0, y0, rw, rh, 0, 0, rw, rh);

            uploadCanvas(crop, rw, rh);

            // Region top-left / size in capture px (texture space)
            lastLayout = {
                offsetX: x0, offsetY: y0,
                sizeX: rw, sizeY: rh,
                pillL: lay.l, pillT: lay.t,
                pillW: lay.w, pillH: lay.h,
                resW: canvas.width, resH: canvas.height,
                vw: lay.vw, vh: lay.vh
            };
            done(true);
        }).catch(function (err) {
            dbg('lg: capture failed', err);
            done(false);
        });
    }

    // ----------------------------------------------------------
    // Render loop
    // ----------------------------------------------------------
    var t0 = (window.performance && performance.now) ? performance.now() : Date.now();

    function render() {
        window.requestAnimationFrame(render);

        if (!hasTexture || !lastLayout || !GLASS.offsetParent) {
            return; // canvas stays transparent over the CSS fallback
        }

        gl.enable(gl.SCISSOR_TEST);
        gl.viewport(0, 0, canvas.width, canvas.height);
        gl.scissor(0, 0, canvas.width, canvas.height);

        var now = ((window.performance && performance.now) ? performance.now() : Date.now()) - t0;
        var deg = (cfg.lightSpeedDeg * now / 1000.0) % 360.0;

        gl.useProgram(prog);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, texture);

        gl.uniform2f(U.u_resolution, lastLayout.resW, lastLayout.resH);
        gl.uniform2f(U.u_touch, 0, 0);

        gl.uniform4f(U.u_lensGeom,
            lastLayout.pillW, lastLayout.pillH,
            cfg.cornerRadius * cap, cfg.cornerStyle);
        gl.uniform4f(U.u_warp,
            cfg.magnification, cfg.distortion,
            cfg.distortionThicknessPx * cap, 0);

        gl.uniform1f(U.u_diagonalFlip, 0);
        gl.uniform1f(U.u_borderWidth, cfg.borderWidth * cap);
        gl.uniform1f(U.u_borderSoftness, cfg.borderSoftness * cap);
        gl.uniform4fv(U.u_borderColor, [0, 0, 0, 0]);
        gl.uniform1f(U.u_borderAlpha, cfg.borderAlpha);
        gl.uniform1f(U.u_lightIntensity, cfg.lightIntensity);
        gl.uniform4fv(U.u_lightColor, cfg.lightColor);
        gl.uniform4fv(U.u_shadowColor, cfg.shadowColor);
        gl.uniform1f(U.u_lightDirection, deg);
        gl.uniform4fv(U.u_lensColor, cfg.lensColor);

        gl.uniform4f(U.u_packA,
            cfg.oneSideLightIntensity, cfg.chromaticAberration,
            cfg.saturation, cfg.lightMode);
        gl.uniform4f(U.u_packB,
            cfg.refractionMode, cfg.refractionType,
            cfg.refractionIndex, cfg.ambientIntensity);
        gl.uniform4f(U.u_packC,
            cfg.doubleSideLightIntensity, cfg.borderSaturation,
            cfg.borderSolidity, cfg.borderMode);

        gl.uniform1f(U.u_lightSpread, cfg.lightSpread);
        gl.uniform2f(U.u_imageOffset, lastLayout.offsetX, lastLayout.offsetY);
        gl.uniform2f(U.u_imageSize, lastLayout.sizeX, lastLayout.sizeY);
        gl.uniform1f(U.u_honorBackdropAlpha, cfg.honorBackdropAlpha);
        gl.uniform1f(U.u_shapeAaPx, cap);
        gl.uniform2f(U.u_shapeScale, 1, 1);
        gl.uniform4f(U.u_xformRow, 1, 0, 0, 1);
        gl.uniform2f(U.u_xformOff, lastLayout.pillL, lastLayout.pillT);

        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    // ----------------------------------------------------------
    // Capture triggers
    // ----------------------------------------------------------
    var scrollT = null;
    function onScroll() {
        if (scrollT) { clearTimeout(scrollT); }
        scrollT = setTimeout(function () {
            scrollT = null;
            doCapture();
        }, 140); // settle cadence
    }
    VIEW.addEventListener('scroll', onScroll, { passive: true });

    // Track theme switches + DOM changes under the pill (identity poll)
    var lastSig = '';
    var sig = function () {
        var dark = document.body && document.body.classList.contains('dark') ? 1 : 0;
        var inner = VIEW.querySelector('.view-content');
        var len = inner ? inner.innerHTML.length : 0;
        return (VIEW.scrollTop | 0) + '|' + dark + '|' + len + '|' +
               VIEW.clientWidth + 'x' + VIEW.clientHeight;
    };
    setInterval(function () {
        var s = sig();
        if (s !== lastSig && (canvas.width > 1)) {
            lastSig = s;
            onScroll();
        }
    }, 1200);

    // After navigation hints: the active view may change
    setInterval(function () {
        var active = document.querySelector('.view.active');
        if (!active) return;
        if (active === VIEW) {
            if (!GLASS.classList.contains('lg-active') && !hasTexture) doCapture();
        }
    }, 900);

    // Resize / orientation
    function onResize() {
        doCapture();
    }
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);

    // ----------------------------------------------------------
    // Boot
    // ----------------------------------------------------------
    var bootTimer = null;
    function boot() {
        bootTimer = null;
        lastSig = sig();
        doCapture();
    }
    if (document.readyState === 'complete') {
        bootTimer = setTimeout(boot, 120);
    } else {
        window.addEventListener('load', function () {
            bootTimer = setTimeout(boot, 120);
        });
    }
    if (document.fonts && document.fonts.ready) {
        document.fonts.ready.then(function () {
            if (bootTimer) { clearTimeout(bootTimer); bootTimer = null; }
            doCapture();
        });
    }

        // Show the WebGL glass at once (themed fallback backdrop), even if
        // the html-to-image capture takes a moment or fails on iOS.
        ensureFallback();

        // Kick the render loop
        window.requestAnimationFrame(render);
    }

    // ---- Kick off once the DOM + glass exist ----
    var bootTries = 0;
    function boot() {
        VIEW = document.getElementById('v-main');
        GLASS = findGlass();
        dbg('lg: boot tick VIEW=%s GLASS=%s webgl=%s hti=%s',
            !!VIEW, !!GLASS, webglReady, htmlToImageReady);

        // Capabilities missing entirely: nothing we can do, give up quietly.
        if (!htmlToImageReady) { diag('html-to-image не загружен'); return; }
        if (!webglReady) { diag('WebGL недоступен'); return; }

        if (!VIEW || !GLASS) {
            if (++bootTries > 60) { diag('#v-main или .search-glass не найдены'); return; }
            setTimeout(boot, 100);
            return;
        }
        try {
            start();
        } catch (e) {
            diag('start(): ' + (e && e.message ? e.message : e));
        }
    }
    boot();
})();