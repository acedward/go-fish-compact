import {
	type CircuitContext,
	QueryContext,
	sampleContractAddress,
	createConstructorContext,
	CostModel,
} from '@midnight-ntwrk/compact-runtime';
import {Contract, type Witnesses} from '../go-fish/contract/index.js';
import type {PrivateState} from './witnesses.js';
import {witnesses} from './witnesses.js';

export class CardSimulator {
	readonly contract: Contract<PrivateState, Witnesses<PrivateState>>;
	circuitContext: CircuitContext<PrivateState>;

	constructor() {
		// Type assertion needed because go-fish contract witnesses have different signatures
		// than the deck-full contract interface we're importing
		this.contract = new Contract<PrivateState, Witnesses<PrivateState>>(
			witnesses,
		);
		const {currentPrivateState, currentContractState, currentZswapLocalState} =
			this.contract.initialState(createConstructorContext({}, '0'.repeat(64)));
		this.circuitContext = {
			currentPrivateState,
			currentZswapLocalState,
			currentQueryContext: new QueryContext(
				currentContractState.data,
				sampleContractAddress(),
			),
			costModel: CostModel.initialCostModel(),
		};
	}
}


