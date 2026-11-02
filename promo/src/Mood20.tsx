import type { ReactNode } from 'react';
import {
  AbsoluteFill,
  Audio,
  Easing,
  Img,
  Sequence,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';

const C = {
  bg: '#15131e',
  accent: '#7c4dff',
  accent2: '#9d45fe',
  text: '#f4f2fb',
  muted: 'rgba(244,242,251,0.62)',
  green: '#32d74b',
};

const FONT =
  '-apple-system, BlinkMacSystemFont, "SF Pro Display", "Inter", "Segoe UI", sans-serif';

const clamp = { extrapolateLeft: 'clamp' as const, extrapolateRight: 'clamp' as const };

function enter(delay = 0, damping = 16, stiffness = 130) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return spring({
    frame: Math.max(0, frame - delay),
    fps,
    config: { damping, stiffness },
  });
}

/* ───────────────────────────── фон ───────────────────────────── */

function Background() {
  const frame = useCurrentFrame();
  const x1 = 48 + Math.sin(frame / 55) * 14;
  const y1 = 24 + Math.cos(frame / 70) * 10;
  const x2 = 78 + Math.cos(frame / 80) * 10;

  return (
    <AbsoluteFill style={{ background: C.bg, overflow: 'hidden' }}>
      <div
        style={{
          position: 'absolute',
          inset: '-30%',
          background: `radial-gradient(circle at ${x1}% ${y1}%, rgba(124,77,255,0.50), transparent 50%)`,
        }}
      />
      <div
        style={{
          position: 'absolute',
          inset: 0,
          background: `radial-gradient(circle at ${x2}% 82%, rgba(157,69,254,0.24), transparent 46%)`,
        }}
      />
      <div
        style={{
          position: 'absolute',
          left: '-20%',
          top: `${20 + Math.sin(frame / 40) * 12}%`,
          width: '140%',
          height: 160,
          transform: `rotate(-18deg) translateX(${Math.sin(frame / 50) * 120}px)`,
          background: 'linear-gradient(90deg, transparent, rgba(157,69,254,.16), transparent)',
          filter: 'blur(40px)',
        }}
      />
      <div
        style={{
          position: 'absolute',
          inset: 0,
          background: 'radial-gradient(circle at 50% 50%, transparent 45%, rgba(0,0,0,.55) 100%)',
        }}
      />
      <Particles />
    </AbsoluteFill>
  );
}

function Particles() {
  const frame = useCurrentFrame();
  const dots = Array.from({ length: 26 }, (_, i) => {
    const seed = (i * 9301 + 49297) % 233280;
    const left = (seed / 233280) * 1080;
    const speed = 0.25 + ((i * 37) % 100) / 120;
    const top = (1920 + 200 - ((frame * speed + i * 160) % 2300)) % 1920;
    const size = 2 + (i % 4);
    const opacity = 0.15 + (i % 5) * 0.05;
    return { left, top, size, opacity };
  });

  return (
    <AbsoluteFill>
      {dots.map((d, i) => (
        <div
          key={i}
          style={{
            position: 'absolute',
            left: d.left,
            top: d.top,
            width: d.size,
            height: d.size,
            borderRadius: '50%',
            background: i % 3 === 0 ? '#cbb8ff' : '#9d45fe',
            opacity: d.opacity,
            boxShadow: '0 0 10px rgba(157,69,254,.8)',
          }}
        />
      ))}
    </AbsoluteFill>
  );
}

/* ───────────────────────────── сцена ───────────────────────────── */

function Scene({
  duration,
  children,
  fadeOut = true,
}: {
  duration: number;
  children: ReactNode;
  fadeOut?: boolean;
}) {
  const frame = useCurrentFrame();
  const opacityIn = interpolate(frame, [0, 5], [0, 1], clamp);
  const opacityOut = fadeOut ? interpolate(frame, [duration - 6, duration], [1, 0], clamp) : 1;
  const blurOut = fadeOut ? interpolate(frame, [duration - 8, duration], [0, 8], clamp) : 0;

  return (
    <AbsoluteFill
      style={{
        opacity: Math.min(opacityIn, opacityOut),
        filter: `blur(${blurOut}px)`,
      }}
    >
      {children}
    </AbsoluteFill>
  );
}

/* ───────────────────────────── текст ───────────────────────────── */

function KineticTitle({
  kicker,
  words,
  top = 92,
  size = 62,
}: {
  kicker: string;
  words: Array<{ text: string; accent?: boolean }>;
  top?: number;
  size?: number;
}) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const kick = spring({ frame: Math.max(0, frame - 4), fps, config: { damping: 18, stiffness: 120 } });

  return (
    <div style={{ position: 'absolute', top, left: 60, right: 60, textAlign: 'center' }}>
      <div
        style={{
          fontSize: 20,
          letterSpacing: 6,
          fontWeight: 800,
          color: C.accent2,
          textTransform: 'uppercase',
          opacity: kick,
          transform: `translateY(${interpolate(kick, [0, 1], [16, 0])}px)`,
        }}
      >
        {kicker}
      </div>
      <div
        style={{
          marginTop: 10,
          fontSize: size,
          lineHeight: 1.02,
          fontWeight: 900,
          letterSpacing: -2,
          color: C.text,
        }}
      >
        {words.map((word, i) => {
          const e = spring({
            frame: Math.max(0, frame - 10 - i * 5),
            fps,
            config: { damping: 14, stiffness: 160 },
          });
          return (
            <span
              key={i}
              style={{
                display: 'inline-block',
                marginRight: 16,
                color: word.accent ? C.accent2 : C.text,
                opacity: e,
                transform: `translateY(${interpolate(e, [0, 1], [54, 0])}px) scale(${interpolate(e, [0, 1], [0.92, 1])})`,
                textShadow: word.accent ? '0 0 40px rgba(157,69,254,.55)' : undefined,
              }}
            >
              {word.text}
            </span>
          );
        })}
      </div>
    </div>
  );
}

/* ───────────────────────────── 3D-телефон ───────────────────────────── */

function Phone3D({
  src,
  x = 0,
  y = 0,
  ry = 0,
  rx = 0,
  rz = 0,
  scale = 1,
  width = 690,
  opacity = 1,
  blur = 0,
}: {
  src: string;
  x?: number;
  y?: number;
  ry?: number;
  rx?: number;
  rz?: number;
  scale?: number;
  width?: number;
  opacity?: number;
  blur?: number;
}) {
  const height = width / (1170 / 2532);

  return (
    <div
      style={{
        position: 'absolute',
        left: (1080 - width) / 2 + x,
        top: (1920 - height) / 2 + y,
        width,
        height,
        perspective: 1900,
        opacity,
        filter: `blur(${blur}px)`,
      }}
    >
      <div
        style={{
          width: '100%',
          height: '100%',
          transform: `rotateY(${ry}deg) rotateX(${rx}deg) rotateZ(${rz}deg) scale(${scale})`,
          transformStyle: 'preserve-3d',
        }}
      >
        <div
          style={{
            width: '100%',
            height: '100%',
            borderRadius: 70,
            padding: 8,
            background: 'linear-gradient(155deg,#544b64,#17131f 42%,#2b2438)',
            boxShadow:
              '0 70px 160px rgba(0,0,0,.82), 0 0 0 1px rgba(255,255,255,.10), inset 0 0 0 1px rgba(255,255,255,.05)',
          }}
        >
          <div
            style={{
              position: 'relative',
              width: '100%',
              height: '100%',
              borderRadius: 63,
              overflow: 'hidden',
              background: '#09070d',
            }}
          >
            <Img
              src={staticFile(src)}
              style={{ width: '100%', height: '100%', objectFit: 'contain' }}
            />
            <div
              style={{
                position: 'absolute',
                inset: 0,
                background: 'linear-gradient(116deg,rgba(255,255,255,.12),transparent 34%)',
              }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

/* ───────────────────────────── чипы ───────────────────────────── */

function Chip({
  text,
  x,
  y,
  delay,
  rotate = 0,
  accent = false,
  size = 26,
}: {
  text: string;
  x: number;
  y: number;
  delay: number;
  rotate?: number;
  accent?: boolean;
  size?: number;
}) {
  const frame = useCurrentFrame();
  const e = enter(delay, 13, 180);
  const float = Math.sin((frame + delay) / 16) * 7;

  return (
    <div
      style={{
        position: 'absolute',
        left: x,
        top: y + float,
        padding: `13px ${size > 24 ? 26 : 20}px`,
        borderRadius: 999,
        background: accent ? C.accent : 'rgba(37,32,51,.92)',
        border: '1px solid rgba(255,255,255,.13)',
        color: C.text,
        fontSize: size,
        fontWeight: 700,
        letterSpacing: -0.3,
        boxShadow: accent
          ? '0 18px 50px rgba(124,77,255,.55)'
          : '0 18px 44px rgba(0,0,0,.45)',
        opacity: e,
        transform: `translateY(${interpolate(e, [0, 1], [40, 0])}px) rotate(${rotate}deg) scale(${interpolate(e, [0, 1], [0.85, 1])})`,
      }}
    >
      {text}
    </div>
  );
}

/* ───────────────────────────── сцена 1: расписание ───────────────────────────── */

function ScheduleScene({ duration }: { duration: number }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const fly = spring({ frame: Math.max(0, frame - 6), fps, config: { damping: 15, stiffness: 75 } });
  const y = interpolate(fly, [0, 1], [760, 0]);
  const ry = interpolate(fly, [0, 1], [-42, -6]);
  const rx = interpolate(fly, [0, 1], [14, 0]);
  const scale = interpolate(fly, [0, 1], [0.7, 1]);
  const float = Math.sin(frame / 20) * 9;
  const drift = interpolate(frame, [0, duration], [0, 26], clamp);

  const exit = interpolate(frame, [duration - 14, duration], [0, 1], clamp);
  const outX = interpolate(exit, [0, 1], [0, -1250], { easing: Easing.in(Easing.cubic) });
  const outBlur = interpolate(exit, [0, 1], [0, 12]);

  const finger = interpolate(frame, [55, 92], [790, 300], {
    ...clamp,
    easing: Easing.inOut(Easing.cubic),
  });
  const fingerOpacity = Math.min(
    interpolate(frame, [50, 56], [0, 1], clamp),
    interpolate(frame, [92, 100], [1, 0], clamp),
  );

  return (
    <>
      <KineticTitle
        kicker="Расписание"
        words={[{ text: 'Вся' }, { text: 'неделя.' }, { text: 'Один', accent: true }, { text: 'свайп.', accent: true }]}
      />

      <div style={{ position: 'absolute', inset: 0, transform: `translateX(${outX}px)` }}>
        <Phone3D
          src="stock/01-schedule.png"
          y={y + float + drift}
          ry={ry}
          rx={rx}
          scale={scale}
          blur={outBlur}
        />
      </div>

      <div
        style={{
          position: 'absolute',
          left: finger,
          top: 650,
          width: 62,
          height: 62,
          borderRadius: '50%',
          transform: 'translate(-50%,-50%)',
          background: 'rgba(255,255,255,.18)',
          border: '2px solid rgba(255,255,255,.65)',
          boxShadow: '0 0 40px rgba(255,255,255,.35)',
          opacity: fingerOpacity,
        }}
      />

      <Chip text="09:10" x={30} y={540} delay={45} rotate={-6} accent />
      <Chip text="Сейчас" x={915} y={300} delay={65} rotate={-3} />
      <Chip text="Г-312" x={915} y={650} delay={55} rotate={5} />
    </>
  );
}

/* ───────────────────────────── сцена 2: калькулятор ───────────────────────────── */

function SliderThumb({ t }: { t: number }) {
  return (
    <div
      style={{
        position: 'absolute',
        left: `${t * 100}%`,
        top: 10,
        width: 34,
        height: 34,
        marginLeft: -17,
        borderRadius: '50%',
        background: C.accent,
        border: '4px solid #241f36',
        boxShadow: '0 0 26px rgba(124,77,255,.9)',
      }}
    />
  );
}

function CalculatorScene({ duration }: { duration: number }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const cardIn = spring({ frame: Math.max(0, frame - 8), fps, config: { damping: 16, stiffness: 105 } });
  const cardY = interpolate(cardIn, [0, 1], [180, 0]);
  const cardScale = interpolate(cardIn, [0, 1], [0.9, 1]);

  const count = interpolate(frame, [18, 48], [0, 3.6], { ...clamp, easing: Easing.out(Easing.cubic) });
  const current = count.toFixed(2).replace('.', ',');

  const sliderT = interpolate(frame, [70, 108], [0.533, 0.667], { ...clamp, easing: Easing.inOut(Easing.cubic) });
  const target = interpolate(frame, [70, 108], [3.6, 4.0], clamp);
  const planIn = spring({ frame: Math.max(0, frame - 108), fps, config: { damping: 12, stiffness: 180 } });

  const exit = interpolate(frame, [duration - 14, duration], [0, 1], clamp);
  const outX = interpolate(exit, [0, 1], [0, 1300], { easing: Easing.in(Easing.cubic) });
  const outBlur = interpolate(exit, [0, 1], [0, 12]);

  const km = [
    { n: 1, score: '5,0' },
    { n: 2, score: '2,0' },
    { n: 3, score: '5,0' },
    { n: 4, score: '—' },
  ];

  return (
    <>
      <KineticTitle
        kicker="Калькулятор"
        words={[{ text: 'Что' }, { text: 'написать' }, { text: 'для', accent: true }, { text: 'автомата.', accent: true }]}
        size={58}
      />

      <Phone3D src="stock/04-grades.png" x={250} y={-20} ry={20} scale={1.02} opacity={0.22} blur={3} />

      <div
        style={{
          position: 'absolute',
          left: 90,
          top: 500 + cardY,
          width: 900,
          padding: 34,
          borderRadius: 44,
          background: 'linear-gradient(160deg, rgba(42,36,58,.98), rgba(23,19,34,.98))',
          border: '1px solid rgba(255,255,255,.10)',
          boxShadow: '0 60px 140px rgba(0,0,0,.72)',
          transform: `translateX(${outX}px) scale(${cardScale})`,
          filter: `blur(${outBlur}px)`,
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
          <span style={{ fontSize: 24, color: C.muted }}>Математический анализ</span>
          <span style={{ fontSize: 20, color: C.muted }}>Σ балл × вес</span>
        </div>
        <div style={{ marginTop: 6, fontSize: 92, fontWeight: 900, color: C.text, letterSpacing: -4 }}>
          {current}
        </div>
        <div style={{ marginTop: 14, height: 8, borderRadius: 99, background: 'rgba(255,255,255,.10)' }}>
          <div
            style={{
              width: '90%',
              height: '100%',
              borderRadius: 99,
              background: C.accent,
              boxShadow: '0 0 22px rgba(124,77,255,.6)',
            }}
          />
        </div>
        <div style={{ marginTop: 8, fontSize: 19, color: C.muted }}>закрыто 90% веса</div>

        <div style={{ marginTop: 24, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          {km.map((item, i) => {
            const e = spring({
              frame: Math.max(0, frame - 28 - i * 5),
              fps,
              config: { damping: 16, stiffness: 170 },
            });
            return (
              <div
                key={item.n}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 14,
                  padding: '14px 18px',
                  borderRadius: 20,
                  background: 'rgba(255,255,255,.045)',
                  opacity: e,
                  transform: `translateY(${interpolate(e, [0, 1], [20, 0])}px)`,
                }}
              >
                <span style={{ fontSize: 20, color: C.muted }}>КМ {item.n}</span>
                <span style={{ flex: 1 }} />
                <span
                  style={{
                    fontSize: 30,
                    fontWeight: 800,
                    color: item.score === '2,0' ? '#ff453a' : C.text,
                  }}
                >
                  {item.score}
                </span>
              </div>
            );
          })}
        </div>

        <div style={{ marginTop: 26, display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
          <span style={{ fontSize: 20, letterSpacing: 3, color: C.muted }}>ПОРОГ АВТОМАТА</span>
          <span style={{ fontSize: 44, fontWeight: 900, color: C.accent2 }}>
            {target.toFixed(1).replace('.', ',')}
          </span>
        </div>
        <div style={{ position: 'relative', marginTop: 12, height: 54 }}>
          <div
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              top: 19,
              height: 14,
              borderRadius: 99,
              background: 'rgba(255,255,255,.10)',
            }}
          />
          <div
            style={{
              position: 'absolute',
              left: 0,
              width: `${sliderT * 100}%`,
              top: 19,
              height: 14,
              borderRadius: 99,
              background: C.accent,
              boxShadow: '0 0 26px rgba(124,77,255,.7)',
            }}
          />
          <SliderThumb t={sliderT} />
        </div>

        <div
          style={{
            marginTop: 20,
            padding: 22,
            borderRadius: 26,
            background: 'linear-gradient(120deg,#7c4dff,#5a2fc4)',
            display: 'flex',
            alignItems: 'center',
            gap: 18,
            opacity: planIn,
            transform: `translateY(${interpolate(planIn, [0, 1], [34, 0])}px) scale(${interpolate(planIn, [0, 1], [0.94, 1])})`,
            boxShadow: '0 20px 60px rgba(124,77,255,.45)',
          }}
        >
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 20, color: 'rgba(255,255,255,.72)' }}>Что написать</div>
            <div style={{ marginTop: 4, fontSize: 28, fontWeight: 800, color: '#fff' }}>
              КМ 4 · вес 10%
            </div>
          </div>
          <div
            style={{
              padding: '12px 24px',
              borderRadius: 999,
              background: '#fff',
              color: C.accent,
              fontSize: 30,
              fontWeight: 900,
            }}
          >
            ≥ 4
          </div>
        </div>
      </div>

      <Chip text="90% веса" x={70} y={430} delay={30} rotate={-5} accent />
      <Chip text="3 КМ закрыто" x={740} y={420} delay={40} rotate={4} />
    </>
  );
}

/* ───────────────────────────── сцена 3: уведомление ───────────────────────────── */

function NotificationScene({ duration }: { duration: number }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const cardIn = spring({ frame: Math.max(0, frame - 14), fps, config: { damping: 12, stiffness: 130 } });
  const scale = interpolate(cardIn, [0, 1], [0.45, 1]);
  const rotation = interpolate(cardIn, [0, 1], [-14, 0]);
  const five = spring({ frame: Math.max(0, frame - 30), fps, config: { damping: 10, stiffness: 190 } });
  const glow = 0.6 + 0.4 * Math.sin(frame / 7);

  const exit = interpolate(frame, [duration - 14, duration], [0, 1], clamp);
  const outScale = interpolate(exit, [0, 1], [1, 1.3]);
  const outBlur = interpolate(exit, [0, 1], [0, 16]);

  return (
    <>
      <KineticTitle
        kicker="Уведомления"
        words={[{ text: 'Оценка' }, { text: 'пришла' }, { text: 'сама.', accent: true }]}
        size={64}
      />

      <Phone3D src="stock/01-schedule.png" x={-270} y={90} ry={26} rz={-6} scale={0.86} opacity={0.55} blur={1.5} />

      <div
        style={{
          position: 'absolute',
          left: 70,
          top: 430,
          width: 900,
          transform: `scale(${scale * outScale}) rotate(${rotation}deg)`,
          opacity: cardIn,
          filter: `blur(${outBlur}px)`,
        }}
      >
        <div
          style={{
            position: 'absolute',
            inset: -50,
            background: `radial-gradient(circle, rgba(124,77,255,${0.5 * glow}), transparent 68%)`,
            filter: 'blur(40px)',
          }}
        />
        <div
          style={{
            position: 'relative',
            borderRadius: 52,
            padding: 38,
            background: 'linear-gradient(160deg,#28223c,#171322)',
            border: '1px solid rgba(157,69,254,.6)',
            boxShadow: `0 0 ${90 * glow}px rgba(124,77,255,.42)`,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 18 }}>
            <div
              style={{
                width: 78,
                height: 78,
                borderRadius: 24,
                background: 'linear-gradient(150deg,#9d45fe,#6a2ee0)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 34,
                fontWeight: 900,
                color: '#fff',
                boxShadow: '0 12px 34px rgba(124,77,255,.55)',
              }}
            >
              5
            </div>
            <div>
              <div style={{ fontSize: 20, letterSpacing: 4, fontWeight: 800, color: '#b9a7ff' }}>
                НОВАЯ ОЦЕНКА
              </div>
              <div style={{ marginTop: 6, fontSize: 34, fontWeight: 800, color: C.text }}>
                Математический анализ
              </div>
            </div>
          </div>

          <div style={{ marginTop: 30, display: 'flex', alignItems: 'center', gap: 20 }}>
            <span
              style={{
                padding: '10px 22px',
                borderRadius: 999,
                background: 'rgba(124,77,255,.22)',
                color: '#cabaff',
                fontSize: 25,
                fontWeight: 800,
              }}
            >
              КМ 3
            </span>
            <span
              style={{
                fontSize: 150,
                lineHeight: 0.9,
                fontWeight: 900,
                letterSpacing: -8,
                color: '#fff',
                transform: `scale(${interpolate(five, [0, 1], [0.55, 1])})`,
                textShadow: '0 0 60px rgba(157,69,254,.8)',
              }}
            >
              5
            </span>
            <span style={{ fontSize: 26, color: C.muted }}>из 5</span>
          </div>

          <div style={{ marginTop: 22, fontSize: 24, color: C.muted }}>Открыть успеваемость →</div>
        </div>
      </div>

      <Chip text="3 письма" x={90} y={1050} delay={60} rotate={-4} />
      <Chip text="Приказ 123-С" x={620} y={1080} delay={70} rotate={3} />
      <Chip text="Стипендия 3 000 ₽" x={250} y={1190} delay={80} rotate={-2} accent />
    </>
  );
}

/* ───────────────────────────── финал ───────────────────────────── */

function EndScene() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const logo = spring({ frame: Math.max(0, frame - 4), fps, config: { damping: 14, stiffness: 120 } });
  const title = spring({ frame: Math.max(0, frame - 16), fps, config: { damping: 16, stiffness: 140 } });
  const qr = spring({ frame: Math.max(0, frame - 30), fps, config: { damping: 15, stiffness: 120 } });
  const sweep = interpolate(frame, [40, 90], [-30, 130], clamp);

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        paddingTop: 300,
      }}
    >
      <Img
        src={staticFile('icon.png')}
        style={{
          width: 210,
          height: 210,
          borderRadius: 50,
          transform: `scale(${logo}) rotate(${interpolate(logo, [0, 1], [-18, 0])}deg)`,
          opacity: logo,
          boxShadow: '0 40px 100px rgba(124,77,255,.5)',
        }}
      />
      <div
        style={{
          marginTop: 30,
          fontSize: 100,
          fontWeight: 900,
          letterSpacing: -4,
          color: C.text,
          opacity: title,
          transform: `translateY(${interpolate(title, [0, 1], [30, 0])}px)`,
        }}
      >
        Mood
      </div>
      <div style={{ marginTop: 8, fontSize: 30, color: C.muted, opacity: title }}>
        Расписание, оценки и задания МЭИ
      </div>

      <div
        style={{
          marginTop: 46,
          padding: 20,
          borderRadius: 32,
          background: '#fff',
          transform: `scale(${interpolate(qr, [0, 1], [0.8, 1])}) rotate(${interpolate(qr, [0, 1], [8, 0])}deg)`,
          opacity: qr,
          boxShadow: '0 30px 80px rgba(0,0,0,.55)',
          position: 'relative',
          overflow: 'hidden',
        }}
      >
        <Img src={staticFile('qr.png')} style={{ width: 270, height: 270, display: 'block' }} />
        <div
          style={{
            position: 'absolute',
            top: 0,
            bottom: 0,
            left: `${sweep}%`,
            width: 90,
            background: 'linear-gradient(90deg, transparent, rgba(255,255,255,.9), transparent)',
            transform: 'skewX(-18deg)',
          }}
        />
      </div>

      <div style={{ marginTop: 30, fontSize: 42, fontWeight: 800, color: C.accent2, opacity: qr }}>
        mood-app.ru
      </div>
      <div style={{ marginTop: 10, fontSize: 26, color: C.muted, opacity: qr }}>
        Поставь на домашний экран
      </div>
      <div style={{ marginTop: 20, fontSize: 22, letterSpacing: 2, color: 'rgba(244,242,251,.38)', opacity: qr }}>
        БЕСПЛАТНО · БЕЗ TELEGRAM
      </div>
    </div>
  );
}

/* ───────────────────────────── вспышка на стыках ───────────────────────────── */

function Cuts() {
  const frame = useCurrentFrame();
  const cuts = [0, 150, 330, 480];
  let flash = 0;
  for (const cut of cuts) {
    flash = Math.max(flash, Math.max(0, 1 - Math.abs(frame - cut) / 4) * 0.45);
  }
  return (
    <AbsoluteFill
      style={{
        background: 'linear-gradient(120deg,#fff,#cbb8ff)',
        opacity: flash,
        mixBlendMode: 'screen',
      }}
    />
  );
}

/* ───────────────────────────── композиция ───────────────────────────── */

export function Mood20() {
  return (
    <AbsoluteFill style={{ backgroundColor: C.bg, fontFamily: FONT, overflow: 'hidden' }}>
      <Audio src={staticFile('audio.wav')} />
      <Background />

      <Sequence from={0} durationInFrames={150}>
        <Scene duration={150}>
          <ScheduleScene duration={150} />
        </Scene>
      </Sequence>

      <Sequence from={150} durationInFrames={180}>
        <Scene duration={180}>
          <CalculatorScene duration={180} />
        </Scene>
      </Sequence>

      <Sequence from={330} durationInFrames={150}>
        <Scene duration={150}>
          <NotificationScene duration={150} />
        </Scene>
      </Sequence>

      <Sequence from={480} durationInFrames={120}>
        <Scene duration={120} fadeOut={false}>
          <EndScene />
        </Scene>
      </Sequence>

      <Cuts />
    </AbsoluteFill>
  );
}
