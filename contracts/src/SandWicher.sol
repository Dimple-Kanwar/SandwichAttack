// SPDX-License-Identifier: MIT
pragma solidity ^0.8.12;


import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Address.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "./IBEP20.sol";

interface WBNB is IERC20 {
    function deposit() external payable;
    function withdraw(uint) external;
}

interface IPancakeRouter02 {
    function swapExactTokensForTokensSupportingFeeOnTransferTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external;

    function getAmountsOut(uint256 amountIn, address[] calldata path)
        external
        view
        returns (uint256[] memory amounts);
}
interface ISandWicher {
    struct SimulationResult {                 
        uint256 expectedBuy;
        uint256 balanceBeforeBuy;
        uint256 balanceAfterBuy;
        uint256 balanceBeforeSell;
        uint256 balanceAfterSell;
        uint256 expectedSell;
    }
}

contract SandwichAttack is ISandWicher {
    address private owner;
     mapping(address => uint256) private _buyBlock;
    bool public checkBot = true;
    modifier onlyOwner() {
        require(msg.sender == owner, "Only the owner can call this function");
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    /**
     * @dev Buys tokens
     */
   
    function buyToken(bytes calldata _data)
        external
        onlyOwner
    {
        _buy(_data);
    }

    /**
     * Sells tokens
     * Balance of tokens we are selling to be gt > 0
     */
    function sellToken(bytes calldata _data)
        external onlyOwner
    {
        _sell(_data);
    }

    function simulate(bytes calldata _buydata, bytes calldata _selldata)
        external
        onlyOwner
        returns (SimulationResult memory result)
    {
        address[] memory path;
        address router;
        uint256 amountIn;
        // Buy
        (router, amountIn, , path) = abi.decode(
            _buydata,
            (address, uint256, uint256, address[])
        );

        IERC20 toToken = IERC20(path[path.length - 1]);

        uint256 balanceBeforeBuy = toToken.balanceOf(address(this));

        uint256 expectedBuy = getAmountsOut(router, amountIn, path);

        _buy(_buydata);

        uint256 balanceAfterBuy = toToken.balanceOf(address(this));

        // Sell

        (router, path, ) = abi.decode(_selldata, (address, address[], uint256));
        IERC20 fromToken = IERC20(path[path.length - 1]);

        uint256 balanceBeforeSell = fromToken.balanceOf(address(this));
        amountIn = IERC20(path[0]).balanceOf(address(this));
        uint256 expectedSell = getAmountsOut(router, amountIn, path);
        _sell(_selldata);

        uint256 balanceAfterSell = fromToken.balanceOf(address(this));

        return
            SimulationResult({
                expectedBuy: expectedBuy,
                balanceBeforeBuy: balanceBeforeBuy,
                balanceAfterBuy: balanceAfterBuy,
                balanceBeforeSell: balanceBeforeSell,
                balanceAfterSell: balanceAfterSell,
                expectedSell: expectedSell
            });
    }
    function _approve(
        IERC20 token,
        address router,
        uint256 amountIn
    ) internal {
        if (token.allowance(address(this), router) < amountIn) {
            // approving the tokens to be spent by router
            SafeERC20.safeApprove(token, router, amountIn);
        }
    }
    function swapAnalysis(
        address router,
        uint256 amountIn,
        address[] memory path
    ) public payable returns (bool) {
        (bool success, ) = router.call(
            abi.encodeWithSignature(
                "swapExactTokensForTokensSupportingFeeOnTransferTokens(uint256,uint256,address[],address,uint256)",
                amountIn,
                0,
                path,
                address(this),
                block.timestamp
            )
        );
        if (success == false) {
            return false;
        } else {
            return true;
        }
    }
function _buy(bytes calldata _data) internal virtual {
        (
            address router,
            uint256 amountIn,
            uint256 amountOutMin,
            address[] memory path
        ) = abi.decode(_data, (address, uint256,uint256, address[]));

        IERC20 fromToken = IERC20(path[0]);
        if (checkBot){
             require(_buyBlock[path[0]] != block.number, "Bad bot!");
        }
        _buyBlock[path[1]] = block.number;
        _approve(fromToken, router, amountIn);
        IPancakeRouter02(router)
            .swapExactTokensForTokensSupportingFeeOnTransferTokens(
                amountIn,
                amountOutMin,
                path,
                address(this),
                block.timestamp
            );
        

    }

    function _sell(bytes calldata _data) internal virtual{
        (address router, address[] memory path,uint256 amountOutMin) = abi.decode(
            _data,
            (address, address[],uint256)
        );

        IERC20 fromToken = IERC20(path[0]);
        uint256 amountIn = fromToken.balanceOf(address(this));

        require(amountIn > 0, "!BAL");

        _approve(fromToken, router, amountIn);
           IPancakeRouter02(router)
            .swapExactTokensForTokensSupportingFeeOnTransferTokens(
                amountIn,
                amountOutMin,
                path,
                address(this),
                block.timestamp
            );
    }
 

    function getAmountsOut(
        address router,
        uint256 amountIn,
        address[] memory path
    ) internal view returns (uint256) {
        uint256[] memory amounts = IPancakeRouter02(router).getAmountsOut(
            amountIn,
            path
        );
        return amounts[amounts.length - 1];
    }

    function withdrawBNBToOwner() external onlyOwner {
        uint256 balance = address(this).balance;
        payable(msg.sender).transfer(balance);
    }

    function withdrawWBNB(address tokenAddress, uint256 amount) public onlyOwner {
        IBEP20 token = IBEP20(tokenAddress);
        token.transfer(msg.sender, amount);
    }

    function withdrawBEP20(address tokenAddress, uint256 amount) public onlyOwner {
        IBEP20 token = IBEP20(tokenAddress);
        uint256 contractBalance = token.balanceOf(address(this));
        require(contractBalance >= amount, "Insufficient contract balance.");
        token.transfer(msg.sender, amount);
    }

    function call(address payable _to, uint256 _value, bytes memory _data) external onlyOwner {
        (bool success, ) = _to.call{value: _value}(_data);
        require(success, "External call failed");
    }

    receive() external payable {}
}