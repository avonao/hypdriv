import type { CommandInfo, ParsedArgs } from '../args';
import type { IO } from '../io';

/** A CLI command: static help metadata plus the runner. */
export interface Command extends CommandInfo {
  run(args: ParsedArgs, io: IO): Promise<number>;
}

export function defineCommand(command: Command): Command {
  return command;
}
