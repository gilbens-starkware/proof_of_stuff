use starknet::ContractAddress;

pub const VALIDATED: felt252 = 'VALID';
pub const VIRTUAL_SNOS: felt252 = 'VIRTUAL_SNOS';
pub const VIRTUAL_SNOS0: felt252 = 'VIRTUAL_SNOS0';
pub const DOMAIN_TAG: felt252 = 'PROOF_OF_SOLVENCY_V1';

#[starknet::interface]
pub trait IFactRegistry<TContractState> {
    fn verify_sig_and_balance(
        ref self: TContractState,
        account: ContractAddress,
        secret: felt252,
        signature: Array<felt252>,
        min_balance: u256,
        token: ContractAddress,
    );
    fn register_fact(ref self: TContractState, slot: felt252);
    fn is_fact_registered(self: @TContractState, slot: felt252) -> bool;
}

#[starknet::interface]
pub trait IAccount<TContractState> {
    fn is_valid_signature(
        self: @TContractState, hash: felt252, signature: Array<felt252>,
    ) -> felt252;
}

#[starknet::interface]
pub trait IERC20<TContractState> {
    fn balance_of(self: @TContractState, account: ContractAddress) -> u256;
}

#[starknet::contract]
pub mod FactRegistry {
    use core::num::traits::Zero;
    use core::poseidon::poseidon_hash_span;
    use starknet::storage::{
        Map, StorageMapReadAccess, StorageMapWriteAccess, StoragePointerReadAccess,
        StoragePointerWriteAccess,
    };
    use starknet::syscalls::{get_execution_info_v3_syscall, send_message_to_l1_syscall};
    use starknet::{ContractAddress, SyscallResultTrait, get_block_number, get_contract_address};
    use super::{
        DOMAIN_TAG, IAccountDispatcher, IAccountDispatcherTrait, IERC20Dispatcher,
        IERC20DispatcherTrait, IFactRegistry, VALIDATED, VIRTUAL_SNOS, VIRTUAL_SNOS0,
    };

    #[storage]
    struct Storage {
        facts: Map<felt252, bool>,
        expected_program_hash: felt252,
        proof_validity_blocks: u64,
    }

    #[event]
    #[derive(Drop, starknet::Event)]
    pub enum Event {
        SolvencyFactRegistered: SolvencyFactRegistered,
    }

    #[derive(Drop, starknet::Event)]
    pub struct SolvencyFactRegistered {
        #[key]
        pub slot: felt252,
    }

    #[derive(Drop, Serde, Copy)]
    struct ProofFacts {
        proof_version: felt252,
        program_variant: felt252,
        virtual_program_hash: felt252,
        starknet_os_output_version: felt252,
        base_block_number: u64,
        base_block_hash: felt252,
        starknet_os_config_hash: felt252,
        message_to_l1_hashes: Span<felt252>,
    }

    #[constructor]
    fn constructor(
        ref self: ContractState, expected_program_hash: felt252, proof_validity_blocks: u64,
    ) {
        assert(expected_program_hash.is_non_zero(), 'zero program hash');
        assert(proof_validity_blocks.is_non_zero(), 'zero validity blocks');
        self.expected_program_hash.write(expected_program_hash);
        self.proof_validity_blocks.write(proof_validity_blocks);
    }

    #[abi(embed_v0)]
    pub impl FactRegistryImpl of IFactRegistry<ContractState> {
        fn verify_sig_and_balance(
            ref self: ContractState,
            account: ContractAddress,
            secret: felt252,
            signature: Array<felt252>,
            min_balance: u256,
            token: ContractAddress,
        ) {
            assert(account.is_non_zero(), 'zero account');
            assert(secret.is_non_zero(), 'zero secret');
            assert(min_balance.is_non_zero(), 'zero min_balance');
            assert(token.is_non_zero(), 'zero token');

            // Domain-separated hash binding sig to (secret, min_balance, token); never sign raw secret.
            let signed_hash = poseidon_hash_span(
                array![
                    DOMAIN_TAG,
                    secret,
                    min_balance.low.into(),
                    min_balance.high.into(),
                    token.into(),
                ]
                    .span(),
            );

            let account_dispatcher = IAccountDispatcher { contract_address: account };
            let valid = account_dispatcher.is_valid_signature(signed_hash, signature);
            assert(valid == VALIDATED, 'invalid signature');

            let token_dispatcher = IERC20Dispatcher { contract_address: token };
            let balance = token_dispatcher.balance_of(account);
            assert(balance >= min_balance, 'balance below min');

            // output = h(h(secret), block_number, min_balance, token).
            // block_number is the base block inside VIRTUAL_SNOS — the block in which balance was observed.
            let secret_hash = poseidon_hash_span(array![secret].span());
            let output = poseidon_hash_span(
                array![
                    secret_hash,
                    get_block_number().into(),
                    min_balance.low.into(),
                    min_balance.high.into(),
                    token.into(),
                ]
                    .span(),
            );

            send_message_to_l1_syscall(to_address: Zero::zero(), payload: array![output].span())
                .unwrap_syscall();
        }

        fn register_fact(ref self: ContractState, slot: felt252) {
            let execution_info = get_execution_info_v3_syscall().unwrap_syscall();
            let mut proof_facts_span = execution_info.tx_info.proof_facts;
            assert(!proof_facts_span.is_empty(), 'empty proof facts');
            let proof_facts: ProofFacts = Serde::deserialize(ref proof_facts_span)
                .expect('proof facts deserialize error');
            assert(proof_facts_span.is_empty(), 'invalid proof facts');

            assert(proof_facts.program_variant == VIRTUAL_SNOS, 'invalid variant');
            assert(
                proof_facts.starknet_os_output_version == VIRTUAL_SNOS0, 'invalid output version',
            );
            assert(
                proof_facts.virtual_program_hash == self.expected_program_hash.read(),
                'invalid program hash',
            );

            let current_block = execution_info.block_info.block_number;
            assert(proof_facts.base_block_number < current_block, 'invalid base block');
            assert(
                current_block <= proof_facts.base_block_number + self.proof_validity_blocks.read(),
                'proof expired',
            );

            let expected_msg_hash = compute_message_hash(slot, get_contract_address());
            assert(
                proof_facts.message_to_l1_hashes == [expected_msg_hash].span(),
                'invalid message hash',
            );

            self.facts.write(slot, true);
            self.emit(SolvencyFactRegistered { slot });
        }

        fn is_fact_registered(self: @ContractState, slot: felt252) -> bool {
            self.facts.read(slot)
        }
    }

    /// Reconstructs the L1 message hash for a message sent from this contract with payload=[slot]
    /// and to_address=0. Mirrors the format used by VIRTUAL_SNOS to populate
    /// `proof_facts.message_to_l1_hashes`.
    fn compute_message_hash(slot: felt252, contract_address: ContractAddress) -> felt252 {
        let mut l1_message_data: Array<felt252> = array![contract_address.into(), Zero::zero()];
        let payload = array![slot];
        payload.serialize(ref l1_message_data);
        poseidon_hash_span(l1_message_data.span())
    }
}
