type ColorArguments = { channels: string[]; alpha: string | undefined };

const HEX_LITERAL = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const FUNCTION_LITERAL = /^(rgba?|hsla?|oklch|oklab)\(([^()]*)\)$/i;

function clampUnit(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function byteHex(unitValue: number): string {
  return Math.round(clampUnit(unitValue) * 255).toString(16).padStart(2, '0');
}

function toHex(red: number, green: number, blue: number, alpha: number): string {
  const opaqueHex = `#${byteHex(red)}${byteHex(green)}${byteHex(blue)}`;
  const alphaByte = Math.round(clampUnit(alpha) * 255);
  return alphaByte === 255 ? opaqueHex : `${opaqueHex}${alphaByte.toString(16).padStart(2, '0')}`;
}

function splitColorArguments(argumentText: string): ColorArguments | undefined {
  const [channelText = '', alphaText, extra] = argumentText.split('/');
  if (extra !== undefined) return undefined;
  const channels = channelText.split(/[\s,]+/).filter(Boolean);
  if (alphaText !== undefined) return { channels, alpha: alphaText.trim() };
  if (channels.length === 4) return { channels: channels.slice(0, 3), alpha: channels[3] };
  return { channels, alpha: undefined };
}

function parseNumber(token: string, percentScale: number): number | undefined {
  if (token === 'none') return 0;
  const percentMatch = /^(-?[\d.]+(?:e-?\d+)?)%$/i.exec(token);
  if (percentMatch) return (Number(percentMatch[1]) / 100) * percentScale;
  const value = Number(token);
  return Number.isFinite(value) ? value : undefined;
}

function parseHueDegrees(token: string): number | undefined {
  const hueMatch = /^(-?[\d.]+(?:e-?\d+)?)(deg|turn|rad|grad)?$/i.exec(token);
  if (!hueMatch) return token === 'none' ? 0 : undefined;
  const value = Number(hueMatch[1]);
  const degreesPerUnit: Record<string, number> = { deg: 1, turn: 360, rad: 180 / Math.PI, grad: 0.9 };
  return value * (degreesPerUnit[(hueMatch[2] ?? 'deg').toLowerCase()] ?? 1);
}

function parseAlpha(token: string | undefined): number | undefined {
  if (token === undefined) return 1;
  return parseNumber(token, 1);
}

function expandShortHex(hexDigits: string): string {
  if (hexDigits.length > 4) return hexDigits;
  return [...hexDigits].map((digit) => digit + digit).join('');
}

function normalizeHex(hexDigits: string): string {
  const fullDigits = expandShortHex(hexDigits.toLowerCase());
  if (fullDigits.length === 8 && fullDigits.endsWith('ff')) return `#${fullDigits.slice(0, 6)}`;
  return `#${fullDigits}`;
}

function hslToRgb(hueDegrees: number, saturation: number, lightness: number): [number, number, number] {
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const huePrime = (((hueDegrees % 360) + 360) % 360) / 60;
  const secondary = chroma * (1 - Math.abs((huePrime % 2) - 1));
  const lightnessMatch = lightness - chroma / 2;
  const sextant = Math.floor(huePrime) % 6;
  const rgbBySextant: Array<[number, number, number]> = [
    [chroma, secondary, 0], [secondary, chroma, 0], [0, chroma, secondary],
    [0, secondary, chroma], [secondary, 0, chroma], [chroma, 0, secondary],
  ];
  const [red, green, blue] = rgbBySextant[sextant] ?? [0, 0, 0];
  return [red + lightnessMatch, green + lightnessMatch, blue + lightnessMatch];
}

function gammaEncode(linear: number): number {
  const magnitude = Math.abs(linear);
  const encoded = magnitude <= 0.0031308 ? 12.92 * magnitude : 1.055 * magnitude ** (1 / 2.4) - 0.055;
  return Math.sign(linear) * encoded;
}

function oklabToRgb(lightness: number, axisA: number, axisB: number): [number, number, number] {
  const longCone = (lightness + 0.3963377774 * axisA + 0.2158037573 * axisB) ** 3;
  const mediumCone = (lightness - 0.1055613458 * axisA - 0.0638541728 * axisB) ** 3;
  const shortCone = (lightness - 0.0894841775 * axisA - 1.291485548 * axisB) ** 3;
  return [
    gammaEncode(4.0767416621 * longCone - 3.3077115913 * mediumCone + 0.2309699292 * shortCone),
    gammaEncode(-1.2684380046 * longCone + 2.6097574011 * mediumCone - 0.3413193965 * shortCone),
    gammaEncode(-0.0041960863 * longCone - 0.7034186147 * mediumCone + 1.707614701 * shortCone),
  ];
}

function channelsToRgb(functionName: string, channels: string[]): [number, number, number] | undefined {
  const [first = '', second = '', third = ''] = channels;
  if (functionName.startsWith('rgb')) {
    const rgbValues = [first, second, third].map((token) => parseNumber(token, 255));
    if (rgbValues.some((value) => value === undefined)) return undefined;
    const [red = 0, green = 0, blue = 0] = rgbValues as number[];
    return [red / 255, green / 255, blue / 255];
  }
  if (functionName.startsWith('hsl')) {
    const hueDegrees = parseHueDegrees(first);
    const saturation = parseNumber(second.endsWith('%') ? second : `${second}%`, 1);
    const lightness = parseNumber(third.endsWith('%') ? third : `${third}%`, 1);
    if (hueDegrees === undefined || saturation === undefined || lightness === undefined) return undefined;
    return hslToRgb(hueDegrees, saturation, lightness);
  }
  const lightness = parseNumber(first, 1);
  if (lightness === undefined) return undefined;
  if (functionName === 'oklch') {
    const chroma = parseNumber(second, 0.4);
    const hueDegrees = parseHueDegrees(third);
    if (chroma === undefined || hueDegrees === undefined) return undefined;
    const hueRadians = (hueDegrees * Math.PI) / 180;
    return oklabToRgb(lightness, chroma * Math.cos(hueRadians), chroma * Math.sin(hueRadians));
  }
  const axisA = parseNumber(second, 0.4);
  const axisB = parseNumber(third, 0.4);
  if (axisA === undefined || axisB === undefined) return undefined;
  return oklabToRgb(lightness, axisA, axisB);
}

export function normalizeColor(literal: string): string | undefined {
  const trimmed = literal.trim();
  const hexMatch = HEX_LITERAL.exec(trimmed);
  if (hexMatch?.[1]) return normalizeHex(hexMatch[1]);
  const functionMatch = FUNCTION_LITERAL.exec(trimmed);
  if (!functionMatch?.[1] || functionMatch[2] === undefined) return undefined;
  const functionName = functionMatch[1].toLowerCase();
  const colorArguments = splitColorArguments(functionMatch[2].trim());
  if (!colorArguments || colorArguments.channels.length !== 3) return undefined;
  const rgb = channelsToRgb(functionName, colorArguments.channels);
  const alpha = parseAlpha(colorArguments.alpha);
  if (!rgb || alpha === undefined) return undefined;
  return toHex(rgb[0], rgb[1], rgb[2], alpha);
}

function channelsOf(hex: string): number[] {
  return [1, 3, 5, 7].map((start) => Number.parseInt(hex.slice(start, start + 2) || 'ff', 16) / 255);
}

export function blendOver(foregroundHex: string, opaqueBackgroundHex: string): string {
  const [red = 0, green = 0, blue = 0, alpha = 1] = channelsOf(foregroundHex);
  const [backgroundRed = 0, backgroundGreen = 0, backgroundBlue = 0] = channelsOf(opaqueBackgroundHex);
  const mix = (channel: number, backgroundChannel: number) => channel * alpha + backgroundChannel * (1 - alpha);
  return toHex(mix(red, backgroundRed), mix(green, backgroundGreen), mix(blue, backgroundBlue), 1);
}
