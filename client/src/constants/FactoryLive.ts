export const FactoryLive_ABI = [
	{
		"inputs": [
			{
				"internalType": "address",
				"name": "_revealContract",
				"type": "address"
			}
		],
		"stateMutability": "payable",
		"type": "constructor"
	},
	{
		"inputs": [
			{
				"internalType": "bytes32",
				"name": "_salt",
				"type": "bytes32"
			},
			{
				"internalType": "address payable",
				"name": "_owner",
				"type": "address"
			}
		],
		"name": "createSubContract",
		"outputs": [],
		"stateMutability": "nonpayable",
		"type": "function"
	},
	{
		"inputs": [],
		"name": "getActualSubAddress",
		"outputs": [
			{
				"internalType": "address",
				"name": "",
				"type": "address"
			}
		],
		"stateMutability": "view",
		"type": "function"
	},
	{
		"inputs": [
			{
				"internalType": "bytes32",
				"name": "_salt",
				"type": "bytes32"
			},
			{
				"internalType": "address",
				"name": "_owner",
				"type": "address"
			}
		],
		"name": "getPredictedSubAddress",
		"outputs": [
			{
				"internalType": "address",
				"name": "",
				"type": "address"
			}
		],
		"stateMutability": "view",
		"type": "function"
	},
	{
		"inputs": [],
		"name": "getRevealContractAddress",
		"outputs": [
			{
				"internalType": "address",
				"name": "",
				"type": "address"
			}
		],
		"stateMutability": "view",
		"type": "function"
	}
]