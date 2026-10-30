import { agentCommand } from './agent';
import { analyzeCommand } from './analyze';
import { auditCommand } from './audit';
import { benchCommand } from './bench';
import { budgetCommand } from './budget';
import { cspCommand } from './csp';
import { cssCommand } from './css';
import { depsCommand } from './deps';
import { doctorCommand } from './doctor';
import { initCommand } from './init';
import { jobsCommand } from './jobs';
import { manifestCommand } from './manifest';
import { routesCommand } from './routes';
import type { Command } from './types';
import { vitalsCommand } from './vitals';
import { warmCommand } from './warm';

/** Every command in help order. */
export const commands: Command[] = [
  initCommand,
  doctorCommand,
  analyzeCommand,
  routesCommand,
  auditCommand,
  budgetCommand,
  cspCommand,
  cssCommand,
  warmCommand,
  benchCommand,
  depsCommand,
  manifestCommand,
  jobsCommand,
  vitalsCommand,
  agentCommand,
];

export function findCommand(name: string): Command | undefined {
  return commands.find((c) => c.name === name);
}

export type { Command } from './types';
