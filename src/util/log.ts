export type LogLevel = "DEBUG" | "INFO" | "WARNING" | "ERROR";

const LEVEL_ORDER: Record<LogLevel, number> = {
  DEBUG: 10,
  INFO: 20,
  WARNING: 30,
  ERROR: 40,
};

function coerceLevel(value: string): LogLevel {
  const upper = value.trim().toUpperCase();
  if (upper in LEVEL_ORDER) return upper as LogLevel;
  return "INFO";
}

export class Logger {
  private readonly level: LogLevel;
  private secrets: string[] = [];

  constructor(level: string) {
    this.level = coerceLevel(level);
  }

  addSecret(secret: string | undefined): void {
    if (secret && secret.trim().length > 0) {
      this.secrets.push(secret.trim());
    }
  }

  private redact(message: string): string {
    let output = message;
    for (const secret of this.secrets) {
      if (secret) output = output.split(secret).join("***");
    }
    return output;
  }

  private write(level: LogLevel, message: string): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.level]) return;
    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] [${level}] ${this.redact(message)}`;
    if (level === "ERROR") {
      console.error(line);
    } else if (level === "WARNING") {
      console.warn(line);
    } else {
      console.log(line);
    }
  }

  debug(message: string): void {
    this.write("DEBUG", message);
  }

  info(message: string): void {
    this.write("INFO", message);
  }

  warn(message: string): void {
    this.write("WARNING", message);
  }

  error(message: string): void {
    this.write("ERROR", message);
  }
}
