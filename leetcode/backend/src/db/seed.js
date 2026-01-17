const pool = require('./pool');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

const problems = [
  {
    title: 'Two Sum',
    slug: 'two-sum',
    description: `Given an array of integers \`nums\` and an integer \`target\`, return indices of the two numbers such that they add up to \`target\`.

You may assume that each input would have exactly one solution, and you may not use the same element twice.

You can return the answer in any order.`,
    examples: `**Example 1:**
\`\`\`
Input: nums = [2,7,11,15], target = 9
Output: [0,1]
Explanation: Because nums[0] + nums[1] == 9, we return [0, 1].
\`\`\`

**Example 2:**
\`\`\`
Input: nums = [3,2,4], target = 6
Output: [1,2]
\`\`\`

**Example 3:**
\`\`\`
Input: nums = [3,3], target = 6
Output: [0,1]
\`\`\``,
    constraints: `- \`2 <= nums.length <= 10^4\`
- \`-10^9 <= nums[i] <= 10^9\`
- \`-10^9 <= target <= 10^9\`
- Only one valid answer exists.`,
    difficulty: 'easy',
    starter_code_python: `def twoSum(nums, target):
    """
    :type nums: List[int]
    :type target: int
    :rtype: List[int]
    """
    # Your code here
    pass

# Read input
import json
nums = json.loads(input())
target = int(input())
result = twoSum(nums, target)
print(json.dumps(result))`,
    starter_code_javascript: `function twoSum(nums, target) {
    // Your code here
}

// Read input
const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin });
const lines = [];
rl.on('line', (line) => lines.push(line));
rl.on('close', () => {
    const nums = JSON.parse(lines[0]);
    const target = parseInt(lines[1]);
    const result = twoSum(nums, target);
    console.log(JSON.stringify(result));
});`,
    solution_python: `def twoSum(nums, target):
    seen = {}
    for i, num in enumerate(nums):
        complement = target - num
        if complement in seen:
            return [seen[complement], i]
        seen[num] = i
    return []

import json
nums = json.loads(input())
target = int(input())
result = twoSum(nums, target)
print(json.dumps(result))`,
    solution_javascript: `function twoSum(nums, target) {
    const seen = new Map();
    for (let i = 0; i < nums.length; i++) {
        const complement = target - nums[i];
        if (seen.has(complement)) {
            return [seen.get(complement), i];
        }
        seen.set(nums[i], i);
    }
    return [];
}

const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin });
const lines = [];
rl.on('line', (line) => lines.push(line));
rl.on('close', () => {
    const nums = JSON.parse(lines[0]);
    const target = parseInt(lines[1]);
    const result = twoSum(nums, target);
    console.log(JSON.stringify(result));
});`,
    test_cases: [
      { input: '[2,7,11,15]\n9', expected_output: '[0,1]', is_sample: true },
      { input: '[3,2,4]\n6', expected_output: '[1,2]', is_sample: true },
      { input: '[3,3]\n6', expected_output: '[0,1]', is_sample: true },
      { input: '[1,2,3,4,5]\n9', expected_output: '[3,4]', is_sample: false },
      { input: '[0,4,3,0]\n0', expected_output: '[0,3]', is_sample: false },
    ]
  },
  {
    title: 'Palindrome Number',
    slug: 'palindrome-number',
    description: `Given an integer \`x\`, return \`true\` if \`x\` is a palindrome, and \`false\` otherwise.

An integer is a palindrome when it reads the same backward as forward.

For example, \`121\` is a palindrome while \`123\` is not.`,
    examples: `**Example 1:**
\`\`\`
Input: x = 121
Output: true
Explanation: 121 reads as 121 from left to right and from right to left.
\`\`\`

**Example 2:**
\`\`\`
Input: x = -121
Output: false
Explanation: From left to right, it reads -121. From right to left, it becomes 121-. Therefore it is not a palindrome.
\`\`\`

**Example 3:**
\`\`\`
Input: x = 10
Output: false
Explanation: Reads 01 from right to left. Therefore it is not a palindrome.
\`\`\``,
    constraints: `- \`-2^31 <= x <= 2^31 - 1\``,
    difficulty: 'easy',
    starter_code_python: `def isPalindrome(x):
    """
    :type x: int
    :rtype: bool
    """
    # Your code here
    pass

x = int(input())
result = isPalindrome(x)
print(str(result).lower())`,
    starter_code_javascript: `function isPalindrome(x) {
    // Your code here
}

const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
    const x = parseInt(line);
    const result = isPalindrome(x);
    console.log(result);
    rl.close();
});`,
    solution_python: `def isPalindrome(x):
    if x < 0:
        return False
    s = str(x)
    return s == s[::-1]

x = int(input())
result = isPalindrome(x)
print(str(result).lower())`,
    solution_javascript: `function isPalindrome(x) {
    if (x < 0) return false;
    const s = x.toString();
    return s === s.split('').reverse().join('');
}

const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
    const x = parseInt(line);
    const result = isPalindrome(x);
    console.log(result);
    rl.close();
});`,
    test_cases: [
      { input: '121', expected_output: 'true', is_sample: true },
      { input: '-121', expected_output: 'false', is_sample: true },
      { input: '10', expected_output: 'false', is_sample: true },
      { input: '12321', expected_output: 'true', is_sample: false },
      { input: '0', expected_output: 'true', is_sample: false },
    ]
  },
  {
    title: 'Valid Parentheses',
    slug: 'valid-parentheses',
    description: `Given a string \`s\` containing just the characters \`'('\`, \`')'\`, \`'{'\`, \`'}'\`, \`'['\` and \`']'\`, determine if the input string is valid.

An input string is valid if:

1. Open brackets must be closed by the same type of brackets.
2. Open brackets must be closed in the correct order.
3. Every close bracket has a corresponding open bracket of the same type.`,
    examples: `**Example 1:**
\`\`\`
Input: s = "()"
Output: true
\`\`\`

**Example 2:**
\`\`\`
Input: s = "()[]{}"
Output: true
\`\`\`

**Example 3:**
\`\`\`
Input: s = "(]"
Output: false
\`\`\``,
    constraints: `- \`1 <= s.length <= 10^4\`
- \`s\` consists of parentheses only \`'()[]{}'\`.`,
    difficulty: 'easy',
    starter_code_python: `def isValid(s):
    """
    :type s: str
    :rtype: bool
    """
    # Your code here
    pass

s = input().strip()
result = isValid(s)
print(str(result).lower())`,
    starter_code_javascript: `function isValid(s) {
    // Your code here
}

const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
    const result = isValid(line.trim());
    console.log(result);
    rl.close();
});`,
    solution_python: `def isValid(s):
    stack = []
    mapping = {')': '(', '}': '{', ']': '['}
    for char in s:
        if char in mapping:
            if not stack or stack.pop() != mapping[char]:
                return False
        else:
            stack.append(char)
    return len(stack) == 0

s = input().strip()
result = isValid(s)
print(str(result).lower())`,
    solution_javascript: `function isValid(s) {
    const stack = [];
    const mapping = { ')': '(', '}': '{', ']': '[' };
    for (const char of s) {
        if (char in mapping) {
            if (stack.length === 0 || stack.pop() !== mapping[char]) {
                return false;
            }
        } else {
            stack.push(char);
        }
    }
    return stack.length === 0;
}

const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
    const result = isValid(line.trim());
    console.log(result);
    rl.close();
});`,
    test_cases: [
      { input: '()', expected_output: 'true', is_sample: true },
      { input: '()[]{}', expected_output: 'true', is_sample: true },
      { input: '(]', expected_output: 'false', is_sample: true },
      { input: '([{}])', expected_output: 'true', is_sample: false },
      { input: '((()))', expected_output: 'true', is_sample: false },
      { input: '([)]', expected_output: 'false', is_sample: false },
    ]
  },
  {
    title: 'Merge Two Sorted Lists',
    slug: 'merge-two-sorted-lists',
    description: `You are given the heads of two sorted linked lists \`list1\` and \`list2\`.

Merge the two lists into one sorted list. The list should be made by splicing together the nodes of the first two lists.

Return the head of the merged linked list.

**Note:** For this problem, we represent linked lists as arrays for simplicity.`,
    examples: `**Example 1:**
\`\`\`
Input: list1 = [1,2,4], list2 = [1,3,4]
Output: [1,1,2,3,4,4]
\`\`\`

**Example 2:**
\`\`\`
Input: list1 = [], list2 = []
Output: []
\`\`\`

**Example 3:**
\`\`\`
Input: list1 = [], list2 = [0]
Output: [0]
\`\`\``,
    constraints: `- The number of nodes in both lists is in the range \`[0, 50]\`.
- \`-100 <= Node.val <= 100\`
- Both \`list1\` and \`list2\` are sorted in non-decreasing order.`,
    difficulty: 'easy',
    starter_code_python: `def mergeTwoLists(list1, list2):
    """
    :type list1: List[int]
    :type list2: List[int]
    :rtype: List[int]
    """
    # Your code here
    pass

import json
list1 = json.loads(input())
list2 = json.loads(input())
result = mergeTwoLists(list1, list2)
print(json.dumps(result))`,
    starter_code_javascript: `function mergeTwoLists(list1, list2) {
    // Your code here
}

const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin });
const lines = [];
rl.on('line', (line) => lines.push(line));
rl.on('close', () => {
    const list1 = JSON.parse(lines[0]);
    const list2 = JSON.parse(lines[1]);
    const result = mergeTwoLists(list1, list2);
    console.log(JSON.stringify(result));
});`,
    solution_python: `def mergeTwoLists(list1, list2):
    result = []
    i = j = 0
    while i < len(list1) and j < len(list2):
        if list1[i] <= list2[j]:
            result.append(list1[i])
            i += 1
        else:
            result.append(list2[j])
            j += 1
    result.extend(list1[i:])
    result.extend(list2[j:])
    return result

import json
list1 = json.loads(input())
list2 = json.loads(input())
result = mergeTwoLists(list1, list2)
print(json.dumps(result))`,
    solution_javascript: `function mergeTwoLists(list1, list2) {
    const result = [];
    let i = 0, j = 0;
    while (i < list1.length && j < list2.length) {
        if (list1[i] <= list2[j]) {
            result.push(list1[i++]);
        } else {
            result.push(list2[j++]);
        }
    }
    return result.concat(list1.slice(i), list2.slice(j));
}

const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin });
const lines = [];
rl.on('line', (line) => lines.push(line));
rl.on('close', () => {
    const list1 = JSON.parse(lines[0]);
    const list2 = JSON.parse(lines[1]);
    const result = mergeTwoLists(list1, list2);
    console.log(JSON.stringify(result));
});`,
    test_cases: [
      { input: '[1,2,4]\n[1,3,4]', expected_output: '[1,1,2,3,4,4]', is_sample: true },
      { input: '[]\n[]', expected_output: '[]', is_sample: true },
      { input: '[]\n[0]', expected_output: '[0]', is_sample: true },
      { input: '[1,5,10]\n[2,3,7,15]', expected_output: '[1,2,3,5,7,10,15]', is_sample: false },
    ]
  },
  {
    title: 'Maximum Subarray',
    slug: 'maximum-subarray',
    description: `Given an integer array \`nums\`, find the subarray with the largest sum, and return its sum.

A subarray is a contiguous non-empty sequence of elements within an array.`,
    examples: `**Example 1:**
\`\`\`
Input: nums = [-2,1,-3,4,-1,2,1,-5,4]
Output: 6
Explanation: The subarray [4,-1,2,1] has the largest sum 6.
\`\`\`

**Example 2:**
\`\`\`
Input: nums = [1]
Output: 1
Explanation: The subarray [1] has the largest sum 1.
\`\`\`

**Example 3:**
\`\`\`
Input: nums = [5,4,-1,7,8]
Output: 23
Explanation: The subarray [5,4,-1,7,8] has the largest sum 23.
\`\`\``,
    constraints: `- \`1 <= nums.length <= 10^5\`
- \`-10^4 <= nums[i] <= 10^4\``,
    difficulty: 'medium',
    starter_code_python: `def maxSubArray(nums):
    """
    :type nums: List[int]
    :rtype: int
    """
    # Your code here
    pass

import json
nums = json.loads(input())
result = maxSubArray(nums)
print(result)`,
    starter_code_javascript: `function maxSubArray(nums) {
    // Your code here
}

const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
    const nums = JSON.parse(line);
    const result = maxSubArray(nums);
    console.log(result);
    rl.close();
});`,
    solution_python: `def maxSubArray(nums):
    max_sum = nums[0]
    current_sum = nums[0]
    for i in range(1, len(nums)):
        current_sum = max(nums[i], current_sum + nums[i])
        max_sum = max(max_sum, current_sum)
    return max_sum

import json
nums = json.loads(input())
result = maxSubArray(nums)
print(result)`,
    solution_javascript: `function maxSubArray(nums) {
    let maxSum = nums[0];
    let currentSum = nums[0];
    for (let i = 1; i < nums.length; i++) {
        currentSum = Math.max(nums[i], currentSum + nums[i]);
        maxSum = Math.max(maxSum, currentSum);
    }
    return maxSum;
}

const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
    const nums = JSON.parse(line);
    const result = maxSubArray(nums);
    console.log(result);
    rl.close();
});`,
    test_cases: [
      { input: '[-2,1,-3,4,-1,2,1,-5,4]', expected_output: '6', is_sample: true },
      { input: '[1]', expected_output: '1', is_sample: true },
      { input: '[5,4,-1,7,8]', expected_output: '23', is_sample: true },
      { input: '[-1,-2,-3,-4]', expected_output: '-1', is_sample: false },
      { input: '[1,2,3,4,5]', expected_output: '15', is_sample: false },
    ]
  },
  {
    title: 'Longest Common Subsequence',
    slug: 'longest-common-subsequence',
    description: `Given two strings \`text1\` and \`text2\`, return the length of their longest common subsequence. If there is no common subsequence, return \`0\`.

A subsequence of a string is a new string generated from the original string with some characters (can be none) deleted without changing the relative order of the remaining characters.

For example, \`"ace"\` is a subsequence of \`"abcde"\`.

A common subsequence of two strings is a subsequence that is common to both strings.`,
    examples: `**Example 1:**
\`\`\`
Input: text1 = "abcde", text2 = "ace"
Output: 3
Explanation: The longest common subsequence is "ace" and its length is 3.
\`\`\`

**Example 2:**
\`\`\`
Input: text1 = "abc", text2 = "abc"
Output: 3
Explanation: The longest common subsequence is "abc" and its length is 3.
\`\`\`

**Example 3:**
\`\`\`
Input: text1 = "abc", text2 = "def"
Output: 0
Explanation: There is no such common subsequence, so the result is 0.
\`\`\``,
    constraints: `- \`1 <= text1.length, text2.length <= 1000\`
- \`text1\` and \`text2\` consist of only lowercase English characters.`,
    difficulty: 'medium',
    starter_code_python: `def longestCommonSubsequence(text1, text2):
    """
    :type text1: str
    :type text2: str
    :rtype: int
    """
    # Your code here
    pass

text1 = input().strip()
text2 = input().strip()
result = longestCommonSubsequence(text1, text2)
print(result)`,
    starter_code_javascript: `function longestCommonSubsequence(text1, text2) {
    // Your code here
}

const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin });
const lines = [];
rl.on('line', (line) => lines.push(line.trim()));
rl.on('close', () => {
    const result = longestCommonSubsequence(lines[0], lines[1]);
    console.log(result);
});`,
    solution_python: `def longestCommonSubsequence(text1, text2):
    m, n = len(text1), len(text2)
    dp = [[0] * (n + 1) for _ in range(m + 1)]
    for i in range(1, m + 1):
        for j in range(1, n + 1):
            if text1[i-1] == text2[j-1]:
                dp[i][j] = dp[i-1][j-1] + 1
            else:
                dp[i][j] = max(dp[i-1][j], dp[i][j-1])
    return dp[m][n]

text1 = input().strip()
text2 = input().strip()
result = longestCommonSubsequence(text1, text2)
print(result)`,
    solution_javascript: `function longestCommonSubsequence(text1, text2) {
    const m = text1.length, n = text2.length;
    const dp = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));
    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            if (text1[i-1] === text2[j-1]) {
                dp[i][j] = dp[i-1][j-1] + 1;
            } else {
                dp[i][j] = Math.max(dp[i-1][j], dp[i][j-1]);
            }
        }
    }
    return dp[m][n];
}

const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin });
const lines = [];
rl.on('line', (line) => lines.push(line.trim()));
rl.on('close', () => {
    const result = longestCommonSubsequence(lines[0], lines[1]);
    console.log(result);
});`,
    test_cases: [
      { input: 'abcde\nace', expected_output: '3', is_sample: true },
      { input: 'abc\nabc', expected_output: '3', is_sample: true },
      { input: 'abc\ndef', expected_output: '0', is_sample: true },
      { input: 'bsbininm\njmjkbkjkv', expected_output: '1', is_sample: false },
    ]
  },
  {
    title: 'Median of Two Sorted Arrays',
    slug: 'median-of-two-sorted-arrays',
    description: `Given two sorted arrays \`nums1\` and \`nums2\` of size \`m\` and \`n\` respectively, return the median of the two sorted arrays.

The overall run time complexity should be O(log (m+n)).`,
    examples: `**Example 1:**
\`\`\`
Input: nums1 = [1,3], nums2 = [2]
Output: 2.0
Explanation: merged array = [1,2,3] and median is 2.
\`\`\`

**Example 2:**
\`\`\`
Input: nums1 = [1,2], nums2 = [3,4]
Output: 2.5
Explanation: merged array = [1,2,3,4] and median is (2 + 3) / 2 = 2.5.
\`\`\``,
    constraints: `- \`nums1.length == m\`
- \`nums2.length == n\`
- \`0 <= m <= 1000\`
- \`0 <= n <= 1000\`
- \`1 <= m + n <= 2000\`
- \`-10^6 <= nums1[i], nums2[i] <= 10^6\``,
    difficulty: 'hard',
    starter_code_python: `def findMedianSortedArrays(nums1, nums2):
    """
    :type nums1: List[int]
    :type nums2: List[int]
    :rtype: float
    """
    # Your code here
    pass

import json
nums1 = json.loads(input())
nums2 = json.loads(input())
result = findMedianSortedArrays(nums1, nums2)
print(result)`,
    starter_code_javascript: `function findMedianSortedArrays(nums1, nums2) {
    // Your code here
}

const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin });
const lines = [];
rl.on('line', (line) => lines.push(line));
rl.on('close', () => {
    const nums1 = JSON.parse(lines[0]);
    const nums2 = JSON.parse(lines[1]);
    const result = findMedianSortedArrays(nums1, nums2);
    console.log(result);
});`,
    solution_python: `def findMedianSortedArrays(nums1, nums2):
    merged = sorted(nums1 + nums2)
    n = len(merged)
    if n % 2 == 1:
        return float(merged[n // 2])
    else:
        return (merged[n // 2 - 1] + merged[n // 2]) / 2.0

import json
nums1 = json.loads(input())
nums2 = json.loads(input())
result = findMedianSortedArrays(nums1, nums2)
print(result)`,
    solution_javascript: `function findMedianSortedArrays(nums1, nums2) {
    const merged = [...nums1, ...nums2].sort((a, b) => a - b);
    const n = merged.length;
    if (n % 2 === 1) {
        return merged[Math.floor(n / 2)];
    } else {
        return (merged[n / 2 - 1] + merged[n / 2]) / 2;
    }
}

const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin });
const lines = [];
rl.on('line', (line) => lines.push(line));
rl.on('close', () => {
    const nums1 = JSON.parse(lines[0]);
    const nums2 = JSON.parse(lines[1]);
    const result = findMedianSortedArrays(nums1, nums2);
    console.log(result);
});`,
    test_cases: [
      { input: '[1,3]\n[2]', expected_output: '2.0', is_sample: true },
      { input: '[1,2]\n[3,4]', expected_output: '2.5', is_sample: true },
      { input: '[0,0]\n[0,0]', expected_output: '0.0', is_sample: false },
      { input: '[1]\n[2,3,4,5,6]', expected_output: '3.5', is_sample: false },
    ]
  }
];

async function seed() {
  console.log('Starting seed...');

  try {
    // Create admin user
    const adminPasswordHash = await bcrypt.hash('admin123', 10);
    const userPasswordHash = await bcrypt.hash('user123', 10);

    await pool.query(`
      INSERT INTO users (id, username, email, password_hash, role)
      VALUES
        ($1, 'admin', 'admin@leetcode.local', $2, 'admin'),
        ($3, 'demo', 'demo@leetcode.local', $4, 'user')
      ON CONFLICT (username) DO NOTHING
    `, [uuidv4(), adminPasswordHash, uuidv4(), userPasswordHash]);

    console.log('Created users: admin (password: admin123), demo (password: user123)');

    // Insert problems
    for (const problem of problems) {
      const problemId = uuidv4();

      await pool.query(`
        INSERT INTO problems (id, title, slug, description, examples, constraints, difficulty, starter_code_python, starter_code_javascript, solution_python, solution_javascript)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        ON CONFLICT (slug) DO UPDATE SET
          title = EXCLUDED.title,
          description = EXCLUDED.description,
          examples = EXCLUDED.examples,
          constraints = EXCLUDED.constraints,
          difficulty = EXCLUDED.difficulty,
          starter_code_python = EXCLUDED.starter_code_python,
          starter_code_javascript = EXCLUDED.starter_code_javascript,
          solution_python = EXCLUDED.solution_python,
          solution_javascript = EXCLUDED.solution_javascript,
          updated_at = NOW()
        RETURNING id
      `, [
        problemId,
        problem.title,
        problem.slug,
        problem.description,
        problem.examples,
        problem.constraints,
        problem.difficulty,
        problem.starter_code_python,
        problem.starter_code_javascript,
        problem.solution_python,
        problem.solution_javascript
      ]);

      // Get the actual problem ID (in case of update)
      const { rows } = await pool.query('SELECT id FROM problems WHERE slug = $1', [problem.slug]);
      const actualProblemId = rows[0].id;

      // Delete existing test cases for this problem
      await pool.query('DELETE FROM test_cases WHERE problem_id = $1', [actualProblemId]);

      // Insert test cases
      for (let i = 0; i < problem.test_cases.length; i++) {
        const tc = problem.test_cases[i];
        await pool.query(`
          INSERT INTO test_cases (id, problem_id, input, expected_output, is_sample, order_index)
          VALUES ($1, $2, $3, $4, $5, $6)
        `, [uuidv4(), actualProblemId, tc.input, tc.expected_output, tc.is_sample, i]);
      }

      console.log(`Created problem: ${problem.title} with ${problem.test_cases.length} test cases`);
    }

    console.log('Seed completed successfully!');
  } catch (error) {
    console.error('Seed error:', error);
    throw error;
  } finally {
    await pool.end();
  }
}

seed().catch(console.error);
