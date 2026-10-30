import { createInstrumentation } from 'hypdriv/instrumentation';
import config from './hypdriv.config';

export const { register, onRequestError } = createInstrumentation({ config });
