import { Composition } from 'remotion';
import { Mood20 } from './Mood20';

export const RemotionRoot = () => (
  <Composition
    id="Mood20"
    component={Mood20}
    durationInFrames={600}
    fps={30}
    width={1080}
    height={1920}
  />
);
