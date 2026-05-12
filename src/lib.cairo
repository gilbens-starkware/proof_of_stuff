use starknet::ContractAddress;

pub const VALIDATED: felt252 = 'VALID';
pub const VIRTUAL_SNOS: felt252 = 'VIRTUAL_SNOS';
pub const VIRTUAL_SNOS0: felt252 = 'VIRTUAL_SNOS0';

// SNIP-12 revision-1 constants for the typed-data schema:
//   StarknetDomain { name: shortstring, version: shortstring, chainId: shortstring, revision: shortstring }
//   Consent        { secret: felt, min_balance: u256, token: ContractAddress }
// Constants are precomputed in client/src/computeTypeHashes.ts so the Cairo
// `signed_hash` matches what Argent X / Braavos sign via `wallet_signTypedData`.
pub const SN_MESSAGE: felt252 = 0x537461726b4e6574204d657373616765;
pub const SNIP12_DOMAIN_TYPE_HASH: felt252 =
    0x1ff2f602e42168014d405a94f75e8a93d640751d71d16311266e140d8b0a210;
pub const SNIP12_CONSENT_TYPE_HASH: felt252 =
    0x101811b9e19f67cce7ea03842506512df607f343c9277b692470897e58093b4;
pub const SNIP12_U256_TYPE_HASH: felt252 =
    0x3b143be38b811560b45593fb2a071ec4ddd0a020e10782be62ffe6f39e0e82c;
pub const SNIP12_DOMAIN_NAME: felt252 = 'ProofOfSolvency';
// starknet.js's typedData encoder parses pure-digit strings as decimals, so
// version "1" and revision "1" both encode to felt 0x1, not the shortstring 0x31.
pub const SNIP12_DOMAIN_VERSION: felt252 = 0x1;
pub const SNIP12_DOMAIN_REVISION: felt252 = 0x1;

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
    use starknet::{
        ContractAddress, SyscallResultTrait, get_block_number, get_contract_address, get_tx_info,
    };
    use super::{
        IAccountDispatcher, IAccountDispatcherTrait, IERC20Dispatcher, IERC20DispatcherTrait,
        IFactRegistry, SN_MESSAGE, SNIP12_CONSENT_TYPE_HASH, SNIP12_DOMAIN_NAME,
        SNIP12_DOMAIN_REVISION, SNIP12_DOMAIN_TYPE_HASH, SNIP12_DOMAIN_VERSION,
        SNIP12_U256_TYPE_HASH, VALIDATED, VIRTUAL_SNOS, VIRTUAL_SNOS0,
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

            // SNIP-12 revision-1 typed-data hash so Argent X / Braavos can sign via
            // `wallet_signTypedData`. The schema and type-hash constants are pinned
            // in client/src/computeTypeHashes.ts and mirrored at the top of this file.
            let signed_hash = compute_snip12_consent_hash(account, secret, min_balance, token);

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

    /// SNIP-12 revision-1 message hash for the Consent schema.
    ///
    ///   StarkNet Message
    ///     || hash(StarknetDomain)
    ///     || account
    ///     || hash(Consent { secret, min_balance: u256, token })
    ///
    /// Reproduces what starknet.js's `typedData.getMessageHash` computes for the
    /// schema defined in client/src/lib/typedData.ts, so a wallet signature on
    /// that typed data validates here via `is_valid_signature`.
    fn compute_snip12_consent_hash(
        account: ContractAddress, secret: felt252, min_balance: u256, token: ContractAddress,
    ) -> felt252 {
        let chain_id = get_tx_info().unbox().chain_id;
        let domain_hash = poseidon_hash_span(
            array![
                SNIP12_DOMAIN_TYPE_HASH,
                SNIP12_DOMAIN_NAME,
                SNIP12_DOMAIN_VERSION,
                chain_id,
                SNIP12_DOMAIN_REVISION,
            ]
                .span(),
        );
        let u256_hash = poseidon_hash_span(
            array![SNIP12_U256_TYPE_HASH, min_balance.low.into(), min_balance.high.into()].span(),
        );
        let consent_hash = poseidon_hash_span(
            array![SNIP12_CONSENT_TYPE_HASH, secret, u256_hash, token.into()].span(),
        );
        poseidon_hash_span(
            array![SN_MESSAGE, domain_hash, account.into(), consent_hash].span(),
        )
    }
}
