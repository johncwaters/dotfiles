import styled from 'styled-components';

const Title = styled.h2`
  font-size: 22px;
  color: ${(props) => props.tone};
`;

export function Hero() {
  return (
    <section className="text-2xl font-bold" aria-label="Lumen Relay hero">
      <h1 style={{ fontSize: 30, letterSpacing: '0.02em' }}>Light that waits &mdash; then moves</h1>
      <img alt="Relay beam" src="/assets/beam.png" />
    </section>
  );
}
export const tagline = 'Lumen Relay keeps rooms calm…';
export const escaped = 'Lumen Relay\'s beam — on';
export const Close = ({ tone }) => <button title="Close dialog" className={`text-lg ${tone}`} aria-description={'Shuts the panel'}><img src={'/assets/close.svg'} alt={'Close mark'} /></button>;
export const Badge = styled.span.attrs({ role: 'status' })`border-radius: 6px;`;
export const Note = () => <p style="font-size: 15px">Noted</p>;
