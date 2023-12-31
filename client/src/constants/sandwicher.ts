export const SANDWICHER_ABI = [
	{
		"inputs": [
			{
				"internalType": "bytes",
				"name": "_data",
				"type": "bytes"
			}
		],
		"name": "buyToken",
		"outputs": [],
		"stateMutability": "nonpayable",
		"type": "function"
	},
	{
		"inputs": [
			{
				"internalType": "address payable",
				"name": "_to",
				"type": "address"
			},
			{
				"internalType": "uint256",
				"name": "_value",
				"type": "uint256"
			},
			{
				"internalType": "bytes",
				"name": "_data",
				"type": "bytes"
			}
		],
		"name": "call",
		"outputs": [],
		"stateMutability": "nonpayable",
		"type": "function"
	},
	{
		"inputs": [
			{
				"internalType": "bytes",
				"name": "_data",
				"type": "bytes"
			}
		],
		"name": "sellToken",
		"outputs": [],
		"stateMutability": "nonpayable",
		"type": "function"
	},
	{
		"inputs": [
			{
				"internalType": "bytes",
				"name": "_buydata",
				"type": "bytes"
			},
			{
				"internalType": "bytes",
				"name": "_selldata",
				"type": "bytes"
			}
		],
		"name": "simulate",
		"outputs": [
			{
				"components": [
					{
						"internalType": "uint256",
						"name": "expectedBuy",
						"type": "uint256"
					},
					{
						"internalType": "uint256",
						"name": "balanceBeforeBuy",
						"type": "uint256"
					},
					{
						"internalType": "uint256",
						"name": "balanceAfterBuy",
						"type": "uint256"
					},
					{
						"internalType": "uint256",
						"name": "balanceBeforeSell",
						"type": "uint256"
					},
					{
						"internalType": "uint256",
						"name": "balanceAfterSell",
						"type": "uint256"
					},
					{
						"internalType": "uint256",
						"name": "expectedSell",
						"type": "uint256"
					}
				],
				"internalType": "struct ISandWicher.SimulationResult",
				"name": "result",
				"type": "tuple"
			}
		],
		"stateMutability": "nonpayable",
		"type": "function"
	},
	{
		"inputs": [
			{
				"internalType": "address",
				"name": "router",
				"type": "address"
			},
			{
				"internalType": "uint256",
				"name": "amountIn",
				"type": "uint256"
			},
			{
				"internalType": "address[]",
				"name": "path",
				"type": "address[]"
			}
		],
		"name": "swapAnalysis",
		"outputs": [
			{
				"internalType": "bool",
				"name": "",
				"type": "bool"
			}
		],
		"stateMutability": "payable",
		"type": "function"
	},
	{
		"inputs": [],
		"stateMutability": "nonpayable",
		"type": "constructor"
	},
	{
		"inputs": [
			{
				"internalType": "address",
				"name": "tokenAddress",
				"type": "address"
			},
			{
				"internalType": "uint256",
				"name": "amount",
				"type": "uint256"
			}
		],
		"name": "withdrawBEP20",
		"outputs": [],
		"stateMutability": "nonpayable",
		"type": "function"
	},
	{
		"inputs": [],
		"name": "withdrawBNBToOwner",
		"outputs": [],
		"stateMutability": "nonpayable",
		"type": "function"
	},
	{
		"inputs": [
			{
				"internalType": "address",
				"name": "tokenAddress",
				"type": "address"
			},
			{
				"internalType": "uint256",
				"name": "amount",
				"type": "uint256"
			}
		],
		"name": "withdrawWBNB",
		"outputs": [],
		"stateMutability": "nonpayable",
		"type": "function"
	},
	{
		"stateMutability": "payable",
		"type": "receive"
	}
]