import chalk from 'chalk';

function supportsColor(): boolean {
  return process.stdout.isTTY && process.env.NO_COLOR !== '1';
}

function colorize(value: string, painter: (input: string) => string): string {
  if (!supportsColor()) {
    return value;
  }
  return painter(value);
}

export function dim(value: string): string {
  return colorize(value, chalk.gray);
}

export function ok(value: string): string {
  return colorize(value, chalk.greenBright);
}

export function warn(value: string): string {
  return colorize(value, chalk.yellowBright);
}
